// Structural checks over infra/akldb.yaml, the node twin of infra/akldb.guard (design A, LDB-AX1..AX6).
// `violations(template, stage, params)` returns strings; empty means the stage's resource set is acceptable.
// The template is parsed with its short-form intrinsics and its Conditions resolved for one stage, so a rule is
// checked against what the stage would actually create.
import fs from "node:fs";
import { parse } from "yaml";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

const SHORT = ["Ref", "Sub", "GetAtt", "If", "Equals", "And", "Or", "Not", "Select", "Split", "FindInMap", "Join", "Condition", "ImportValue", "GetAZs", "Base64", "Cidr"];
const keyOf = (name: string): string => (name === "Ref" || name === "Condition" ? name : `Fn::${name}`);

/** Parses CloudFormation YAML (short-form intrinsics) to plain JSON. Rejects anchors, which CloudFormation does not accept. */
export function loadTemplate(file: string): Json {
  const text = fs.readFileSync(file, "utf8");
  if (/^[^#\n]*[\s:[{,][&*][A-Za-z_]\w*/m.test(text.replace(/"[^"\n]*"/g, '""'))) throw new Error("YAML anchors/aliases are rejected by CloudFormation");
  const customTags = SHORT.flatMap((name) => [
    { tag: `!${name}`, collection: "seq" as const, resolve: (seq: Json) => ({ [keyOf(name)]: seq.toJSON() }) },
    { tag: `!${name}`, collection: "map" as const, resolve: (map: Json) => ({ [keyOf(name)]: map.toJSON() }) },
    { tag: `!${name}`, resolve: (str: string) => (name === "GetAtt" ? { "Fn::GetAtt": String(str).split(".") } : { [keyOf(name)]: str }) },
  ]);
  return parse(text, { customTags, schema: "core" });
}

function paramValue(t: Json, params: Json, name: string): Json {
  return name in params ? params[name] : t.Parameters?.[name]?.Default;
}

function value(t: Json, params: Json, x: Json): Json {
  return x && typeof x === "object" && x.Ref ? paramValue(t, params, x.Ref) : x;
}

function evalCond(t: Json, params: Json, node: Json): boolean {
  if (typeof node === "boolean") return node;
  if (node.Condition) return evalCond(t, params, t.Conditions[node.Condition]);
  if (node["Fn::And"]) return node["Fn::And"].every((n: Json) => evalCond(t, params, n));
  if (node["Fn::Or"]) return node["Fn::Or"].some((n: Json) => evalCond(t, params, n));
  if (node["Fn::Not"]) return !evalCond(t, params, node["Fn::Not"][0]);
  if (node["Fn::Equals"]) {
    const [a, b] = node["Fn::Equals"].map((x: Json) => value(t, params, x));
    return a === b;
  }
  throw new Error(`condition ${JSON.stringify(node)}`);
}

/** The template with Fn::If resolved and unselected resources removed, for one stage. */
export function resolveStage(t: Json, stage: string, extra: Json = {}): { params: Json; resources: Record<string, Json> } {
  const params = { Stage: stage, ...extra };
  const conds = Object.fromEntries(Object.keys(t.Conditions ?? {}).map((c) => [c, evalCond(t, params, { Condition: c })]));
  const walk = (n: Json): Json => {
    if (Array.isArray(n)) return n.map(walk).filter((x) => x !== undefined && !(x && x.Ref === "AWS::NoValue"));
    if (n && typeof n === "object") {
      if (n["Fn::If"]) {
        const [c, a, b] = n["Fn::If"];
        return walk(conds[c] ? a : b);
      }
      const out: Json = {};
      for (const [k, v] of Object.entries(n)) {
        const w = walk(v);
        if (w === undefined || (w && w.Ref === "AWS::NoValue")) continue;
        out[k] = w;
      }
      return out;
    }
    return n;
  };
  const resources: Record<string, Json> = {};
  for (const [id, r] of Object.entries<Json>(t.Resources)) {
    if (r.Condition && !conds[r.Condition]) continue;
    resources[id] = walk(r);
  }
  // The template holds each stateful resource twice (prod's kept one, the others' deletable one: DeletionPolicy
  // cannot take Fn::If). Name them alike so a stage's resolved set is the same ids everywhere.
  const canon = JSON.parse(JSON.stringify(resources).replace(/"(LogTable|DataBucket|LogGroup|JobsLogGroup)Dev"/g, '"$1"'));
  return { params, resources: canon };
}

const arr = (x: Json): Json[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const statements = (doc: Json): Json[] => arr(doc.Statement);

/** Every inline IAM policy document of every role in a resolved stage. */
export function policyDocs(resources: Record<string, Json>): [string, Json][] {
  const docs: [string, Json][] = [];
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === "AWS::IAM::Role") for (const p of r.Properties.Policies ?? []) docs.push([`${id}/${p.PolicyName}`, p.PolicyDocument]);
  }
  return docs;
}

/** The logical ids a stage creates. The alarm set is the AX4 list; the budget is prod only. */
export function expectedResources(stage: string): string[] {
  const common = [
    "LogTable", "DataBucket", "DataBucketPolicy", "LogGroup", "JobsLogGroup", "ApiRole", "ApiFunction", "JobsFunction", "JobsAlarmPrefixFilter", "LiveAlias", "LiveAliasEventConfig",
    "HttpApi", "ApiIntegration", "DefaultRoute", "DefaultStage", "ApiInvokePermission", "CustomDomain", "ApiMapping",
    "SchedulerRole", "JobsSchedule", "KeepWarmSchedule", "AlarmTopic", "AlarmTopicPolicy", "AlarmPrefixFilter", ...alarmsFor(stage),
  ];
  return [...common, ...(stage === "prod" ? ["Budget"] : [])].sort();
}

/** The alarms a stage has: the account's free tier is 10, so only prod gets the full set. */
export const ALARMS_EVERY_STAGE = ["LambdaErrorsAlarm", "AlarmPrefixAlarm"];
export const ALARMS_PROD_ONLY = ["JobsErrorsAlarm", "LambdaThrottlesAlarm", "LambdaDurationAlarm", "Api5xxAlarm", "DdbSystemErrorsAlarm", "DdbThrottledAlarm"];
export const alarmsFor = (stage: string): string[] => (stage === "prod" ? [...ALARMS_EVERY_STAGE, ...ALARMS_PROD_ONLY] : ALARMS_EVERY_STAGE);

export function violations(t: Json, stage: string, extra: Json = {}): string[] {
  const { resources: R, params } = resolveStage(t, stage, extra);
  const v: string[] = [];
  const ofType = (type: string): [string, Json][] => Object.entries(R).filter(([, r]) => r.Type === type);

  for (const [id, r] of Object.entries(R)) {
    if (r.Type.startsWith("AWS::EC2::")) v.push(`${id}: EC2/VPC resource (no VPC)`);
    if (r.Properties?.VpcConfig) v.push(`${id}: VpcConfig (no VPC)`);
    if (r.Type.startsWith("AWS::CloudFront::")) v.push(`${id}: CloudFront (design A has no CDN)`);
    if (r.Type === "AWS::Lambda::Url") v.push(`${id}: Function URL (the HTTP API is the only door)`);
    if (r.Type.startsWith("AWS::WAF")) v.push(`${id}: WAF`);
    if (r.Type.startsWith("AWS::DynamoDB::") && r.Type !== "AWS::DynamoDB::Table") v.push(`${id}: unexpected DynamoDB resource`);
  }

  // The commit log table.
  const tables = ofType("AWS::DynamoDB::Table");
  if (tables.length !== 1) v.push(`${tables.length} DynamoDB tables (the log is the only one)`);
  for (const [id, r] of tables) {
    const p = r.Properties;
    if (p.BillingMode !== "PAY_PER_REQUEST") v.push(`${id}: not on-demand`);
    if (p.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled !== true) v.push(`${id}: PITR off`);
    // Prod keeps its log (Retain + protection); staging and shadow can be deleted and recreated.
    if (stage === "prod") {
      if (p.DeletionProtectionEnabled !== true) v.push(`${id}: no deletion protection`);
      if (r.DeletionPolicy !== "Retain" || r.UpdateReplacePolicy !== "Retain") v.push(`${id}: not Retain`);
    } else {
      if (p.DeletionProtectionEnabled !== false) v.push(`${id}: deletion protection outside prod`);
      if (r.DeletionPolicy !== "Delete" || r.UpdateReplacePolicy !== "Delete") v.push(`${id}: not deletable outside prod`);
    }
    if (!(p.TimeToLiveSpecification?.Enabled === true && p.TimeToLiveSpecification.AttributeName === "ttl")) v.push(`${id}: no TTL on ttl`);
    if (JSON.stringify(p.KeySchema) !== JSON.stringify([{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }])) v.push(`${id}: key schema is not pk/sk`);
  }

  // The data bucket.
  const buckets = ofType("AWS::S3::Bucket");
  for (const [id, r] of buckets) {
    const p = r.Properties;
    if (p.VersioningConfiguration?.Status !== "Enabled") v.push(`${id}: not versioned`);
    const pab = p.PublicAccessBlockConfiguration ?? {};
    for (const k of ["BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets"]) if (pab[k] !== true) v.push(`${id}: ${k} off`);
    if (JSON.stringify(p.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault) !== '{"SSEAlgorithm":"AES256"}') v.push(`${id}: not SSE-S3`);
    const wantPolicy = stage === "prod" ? "Retain" : "Delete";
    if (r.DeletionPolicy !== wantPolicy || r.UpdateReplacePolicy !== wantPolicy) v.push(`${id}: not ${wantPolicy}`);
    const hasTls = ofType("AWS::S3::BucketPolicy").some(([, bp]) => bp.Properties.Bucket.Ref === id && statements(bp.Properties.PolicyDocument).some((s) => s.Effect === "Deny" && s.Condition?.Bool?.["aws:SecureTransport"] === "false"));
    if (!hasTls) v.push(`${id}: no TLS-only bucket policy`);
    for (const rule of p.LifecycleConfiguration?.Rules ?? []) {
      if ("ExpirationInDays" in rule || "ExpirationDate" in rule) v.push(`${id}: lifecycle rule ${rule.Id} expires current objects`);
    }
    const noncurrent = (p.LifecycleConfiguration?.Rules ?? []).find((x: Json) => x.NoncurrentVersionExpiration);
    if (noncurrent?.NoncurrentVersionExpiration?.NoncurrentDays !== 35) v.push(`${id}: noncurrent versions do not expire after 35 days`);
  }

  // The two functions: the api (behind the alias) and the jobs function (same bundle, 600 s, no alias, no URL).
  const fns = ofType("AWS::Lambda::Function");
  if (JSON.stringify(fns.map(([id]) => id).sort()) !== '["ApiFunction","JobsFunction"]') v.push(`Lambda functions ${fns.map(([id]) => id)} (ApiFunction and JobsFunction)`);
  const shape: Record<string, { timeout: number; logGroup: string; env: string[] }> = {
    ApiFunction: { timeout: 35, logGroup: "LogGroup", env: ["DATA_BUCKET", "DISCORD_API_URL", "JOBS_FUNCTION", "LOG_TABLE", "MODQUEUE_DISCORD_COMPONENTS", "SSM_PREFIX", "STAGE"] },
    JobsFunction: { timeout: 600, logGroup: "JobsLogGroup", env: ["DATA_BUCKET", "DISCORD_API_URL", "LOG_TABLE", "MODQUEUE_DISCORD_COMPONENTS", "SSM_PREFIX", "STAGE"] },
  };
  for (const [id, r] of fns) {
    const p = r.Properties;
    const want = shape[id];
    if (p.Runtime !== "nodejs24.x") v.push(`${id}: runtime ${p.Runtime}`);
    if (JSON.stringify(p.Architectures) !== '["arm64"]') v.push(`${id}: not arm64`);
    if (p.MemorySize !== 2048) v.push(`${id}: memory ${p.MemorySize}`);
    if (p.Timeout !== want?.timeout) v.push(`${id}: timeout ${p.Timeout}`);
    if (p.Handler !== "lambda.handler") v.push(`${id}: handler ${p.Handler}`);
    if (p.Code?.S3Key?.Ref !== "CodeKey" || p.Code?.S3Bucket?.Ref !== "ArtifactsBucket") v.push(`${id}: not the shared artifact (CodeKey)`);
    if (p.Role?.["Fn::GetAtt"]?.[0] !== "ApiRole") v.push(`${id}: not the boundary-capped role`);
    const env = p.Environment?.Variables ?? {};
    if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(want?.env)) v.push(`${id}: unexpected environment ${Object.keys(env).sort()}`);
    if (id === "ApiFunction" && env.JOBS_FUNCTION?.["Fn::Sub"] !== "akldb-${Stage}-jobs") v.push(`${id}: JOBS_FUNCTION is not the jobs function`);
    if (p.LoggingConfig?.LogGroup?.Ref !== want?.logGroup) v.push(`${id}: not logging to ${want?.logGroup}`);
    const reserved = params.ReservedConcurrency ?? t.Parameters.ReservedConcurrency.Default;
    if (id === "ApiFunction" && (reserved === "") !== !("ReservedConcurrentExecutions" in p)) v.push(`${id}: ReservedConcurrentExecutions does not follow the parameter`);
    if (id === "JobsFunction" && "ReservedConcurrentExecutions" in p) v.push(`${id}: reserved concurrency (only the api may take it)`);
  }

  // The log groups (AX5): STANDARD, one per function; prod's never expire and are kept, the others keep 14 days and go.
  for (const id of ["LogGroup", "JobsLogGroup"]) {
    const lg = R[id]?.Properties;
    if (!lg || lg.LogGroupClass !== "STANDARD") v.push(`${id}: not STANDARD (Infrequent Access has no metric filters or FilterLogEvents)`);
    const name = id === "LogGroup" ? "api" : "jobs";
    if (lg?.LogGroupName?.["Fn::Sub"] !== `/aws/lambda/akldb-\${Stage}-${name}`) v.push(`${id}: not the function's log group name`);
    if (stage === "prod" && lg && "RetentionInDays" in lg) v.push(`${id}: prod logs must never expire`);
    if (stage !== "prod" && lg?.RetentionInDays !== 14) v.push(`${id}: non-prod retention is 14 days`);
    const lgPolicy = R[id]?.DeletionPolicy;
    if (lgPolicy !== (stage === "prod" ? "Retain" : "Delete")) v.push(`${id}: DeletionPolicy ${lgPolicy}`);
  }

  // The HTTP API.
  const apis = ofType("AWS::ApiGatewayV2::Api");
  if (apis.length !== 1) v.push(`${apis.length} HTTP APIs (one)`);
  for (const [id, r] of apis) {
    if (r.Properties.ProtocolType !== "HTTP") v.push(`${id}: not HTTP`);
    if (r.Properties.DisableExecuteApiEndpoint !== true) v.push(`${id}: the execute-api endpoint is enabled`);
  }
  for (const [id, r] of ofType("AWS::ApiGatewayV2::Route")) if (r.Properties.RouteKey !== "$default") v.push(`${id}: route ${r.Properties.RouteKey}`);
  for (const [id, r] of ofType("AWS::ApiGatewayV2::Integration")) {
    const p = r.Properties;
    if (p.IntegrationUri?.Ref !== "LiveAlias") v.push(`${id}: not the live alias`);
    if (p.PayloadFormatVersion !== "2.0" || p.TimeoutInMillis !== 30000) v.push(`${id}: payload/timeout`);
  }
  for (const [id, r] of ofType("AWS::ApiGatewayV2::Stage")) {
    const d = r.Properties.DefaultRouteSettings;
    if (r.Properties.StageName !== "$default" || r.Properties.AutoDeploy !== true) v.push(`${id}: not an auto-deployed $default stage`);
    if (d?.ThrottlingRateLimit !== 50 || d?.ThrottlingBurstLimit !== 100) v.push(`${id}: throttle is not 50/100`);
  }
  for (const [id, r] of ofType("AWS::ApiGatewayV2::DomainName")) {
    const c = r.Properties.DomainNameConfigurations?.[0] ?? {};
    if (c.EndpointType !== "REGIONAL" || c.SecurityPolicy !== "TLS_1_2") v.push(`${id}: domain is not regional TLS 1.2`);
    if (r.Properties.DomainName?.Ref !== "DomainName" || c.CertificateArn?.Ref !== "CertificateArn") v.push(`${id}: not the DomainName/CertificateArn parameters`);
  }
  for (const [id, r] of ofType("AWS::Lambda::Permission")) {
    if (r.Properties.FunctionName?.Ref !== "LiveAlias") v.push(`${id}: permission on something other than the live alias`);
  }

  // IAM: no wildcard action, no Allow on Resource "*", and the two invoke grants are the alias and nothing else.
  for (const [name, doc] of policyDocs(R)) {
    for (const s of statements(doc)) {
      for (const a of arr(s.Action)) if (typeof a === "string" && a.includes("*")) v.push(`${name}: wildcard action ${a}`);
      if (s.Effect === "Allow" && arr(s.Resource).some((x) => x === "*")) v.push(`${name}: Resource *`);
      if (arr(s.Action).includes("lambda:InvokeFunction")) {
        const r = s.Resource;
        const okFn = r?.["Fn::Sub"] === "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:akldb-${Stage}-api:live";
        const okSched = r?.Ref === "LiveAlias";
        const okJobs = s.Sid === "InvokeJobs" && r?.["Fn::Sub"] === "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:akldb-${Stage}-jobs";
        if (!okFn && !okSched && !okJobs) v.push(`${name}: lambda:InvokeFunction on something other than the live alias (or the jobs function)`);
      }
      // Objects: read and write the three prefixes, delete only the log spill prefix.
      const bucket = "arn:aws:s3:::akldb-${Stage}-data-${AWS::AccountId}";
      if (arr(s.Action).includes("s3:DeleteObject") && (arr(s.Action).length !== 1 || JSON.stringify(s.Resource) !== JSON.stringify({ "Fn::Sub": `${bucket}/log/*` }))) v.push(`${name}: s3:DeleteObject on something other than log/*`);
      if (arr(s.Action).some((a: string) => a === "s3:GetObject" || a === "s3:PutObject")) {
        const got = arr(s.Resource).map((x) => x?.["Fn::Sub"]).sort();
        if (JSON.stringify(got) !== JSON.stringify(["dumps", "log", "snap"].map((p2) => `${bucket}/${p2}/*`).sort())) v.push(`${name}: object access is not exactly snap/, dumps/ and log/`);
      }
    }
  }
  const api = R.ApiRole ? policyDocs({ ApiRole: R.ApiRole }).flatMap(([, d]) => statements(d)) : [];
  const dyn = api.find((s) => arr(s.Action).some((a: string) => a.startsWith("dynamodb:")));
  const wantDyn = ["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"];
  if (JSON.stringify(arr(dyn?.Action).slice().sort()) !== JSON.stringify(wantDyn)) v.push("ApiRole: DynamoDB actions are not exactly the log's");
  if (dyn?.Resource?.["Fn::Sub"] !== "arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/akldb-${Stage}-log") v.push("ApiRole: DynamoDB resource is not the log table");
  for (const [id, r] of ofType("AWS::IAM::Role")) {
    if (r.Properties.PermissionsBoundary?.["Fn::ImportValue"] !== "akldb-boundary-arn") v.push(`${id}: no permissions boundary (the exported akldb-boundary-arn)`);
  }
  const schedRole = R.SchedulerRole?.Properties.AssumeRolePolicyDocument.Statement[0];
  if (schedRole?.Principal?.Service !== "scheduler.amazonaws.com" || !schedRole?.Condition?.StringEquals?.["aws:SourceAccount"]) v.push("SchedulerRole: trust is not scheduler.amazonaws.com scoped to the account");

  // Schedules (AX6): both rate(5 minutes), both on the alias.
  const jobs = R.JobsSchedule?.Properties;
  const warm = R.KeepWarmSchedule?.Properties;
  if (jobs?.ScheduleExpression !== "rate(5 minutes)" || jobs?.Target?.Input !== '{"akldb":"tick"}') v.push("JobsSchedule: rate(5 minutes) with {akldb:tick} missing");
  if (warm?.ScheduleExpression !== "rate(5 minutes)" || warm?.Target?.Input?.["Fn::Sub"] !== '{"akldb":"warm","k":${KeepWarm}}') v.push("KeepWarmSchedule: rate(5 minutes) with {akldb:warm,k:KeepWarm} missing");
  for (const [id, r] of ofType("AWS::Scheduler::Schedule")) {
    if (r.Properties.Target.Arn?.Ref !== "LiveAlias") v.push(`${id}: does not target the live alias`);
    if (r.Properties.Target.RoleArn?.["Fn::GetAtt"]?.[0] !== "SchedulerRole") v.push(`${id}: not the scheduler role`);
  }
  if ((t.Parameters.KeepWarm.Default ?? 0) < 4) v.push("KeepWarm: default below 4");

  // Alarms (AX4): exactly the six, within the free 10, all to the topic, none on a log metric filter.
  const alarms = ofType("AWS::CloudWatch::Alarm");
  if (alarms.length > 10) v.push(`${alarms.length} alarms (free tier is 10)`);
  for (const id of alarmsFor(stage)) if (!(id in R)) v.push(`${id}: missing`);
  for (const id of ALARMS_PROD_ONLY) if (stage !== "prod" && id in R) v.push(`${id}: outside prod (the free tier is 10 alarms)`);
  for (const [id, r] of alarms) if (arr(r.Properties.AlarmActions).some((a) => a?.Ref !== "AlarmTopic") || arr(r.Properties.AlarmActions).length !== 1) v.push(`${id}: not wired to the topic`);
  for (const id of ["LambdaErrorsAlarm", "LambdaThrottlesAlarm", "LambdaDurationAlarm"]) {
    if (R[id] !== undefined && JSON.stringify(R[id].Properties.Dimensions) !== JSON.stringify([{ Name: "FunctionName", Value: { Ref: "ApiFunction" } }])) v.push(`${id}: not scoped to this function (FunctionName dimension)`);
  }
  if (ofType("AWS::CloudWatch::Alarm").some(([, a]) => a.Properties.MetricName === "ConcurrentExecutions" || a.Properties.MetricName === "UnreservedConcurrentExecutions")) v.push("an account-wide concurrency alarm");
  // The uniform failure prefix the code logs, as a metric the alarm reads.
  const filter = R.AlarmPrefixFilter?.Properties;
  if (filter?.FilterPattern !== '"akldb-alarm:"') v.push("AlarmPrefixFilter: pattern is not the akldb-alarm: prefix");
  if (filter?.MetricTransformations?.[0]?.MetricName !== "Alarms" || filter?.MetricTransformations?.[0]?.MetricNamespace?.["Fn::Sub"] !== "akldb/${Stage}") v.push("AlarmPrefixFilter: metric is not akldb/<stage>/Alarms");
  const pa = R.AlarmPrefixAlarm?.Properties;
  if (!(pa?.Namespace?.["Fn::Sub"] === "akldb/${Stage}" && pa?.MetricName === "Alarms" && pa?.EvaluationPeriods === 1 && pa?.Period === 300 && pa?.Threshold === 0 && pa?.ComparisonOperator === "GreaterThanThreshold")) v.push("AlarmPrefixAlarm: not Alarms > 0, 1 of 1 x 5 min");
  const topic = R.AlarmTopic?.Properties;
  if (!arr(topic?.Subscription).some((s) => s.Protocol === "email" && s.Endpoint?.Ref === "AlarmEmail")) v.push("AlarmTopic: no email subscription to AlarmEmail");
  for (const [id, r] of ofType("AWS::SNS::TopicPolicy")) {
    const sids = statements(r.Properties.PolicyDocument).map((s) => s.Sid);
    if (sids.some((s) => !s) || new Set(sids).size !== sids.length) v.push(`${id}: every statement needs a unique Sid`);
  }

  // Budget (AX4): prod only, $2 and $5 actual, $5 forecast, to AlarmEmail.
  const budgets = ofType("AWS::Budgets::Budget");
  if (budgets.length !== (stage === "prod" ? 1 : 0)) v.push("Budget: exactly one, on prod only");
  for (const [id, r] of budgets) {
    const n = r.Properties.NotificationsWithSubscribers.map((x: Json) => `${x.Notification.NotificationType}:${x.Notification.Threshold}`).sort();
    if (JSON.stringify(n) !== JSON.stringify(["ACTUAL:2", "ACTUAL:5", "FORECASTED:5"])) v.push(`${id}: notifications ${n}`);
    if (r.Properties.Budget.BudgetType !== "COST" || r.Properties.Budget.TimeUnit !== "MONTHLY") v.push(`${id}: not a monthly cost budget`);
    for (const x of r.Properties.NotificationsWithSubscribers) if (x.Subscribers[0].Address?.Ref !== "AlarmEmail") v.push(`${id}: not to AlarmEmail`);
  }

  return v;
}
