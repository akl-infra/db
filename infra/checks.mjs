// Structural checks over infra/akldb.yaml, the node twin of akldb.guard (design/aws-port.md sections 3, 5.2).
// `violations(template, stage, params)` returns a list of strings; empty means the stage's resource set is acceptable.
import fs from "node:fs";
import { parse } from "yaml";

const SHORT = ["Ref", "Sub", "GetAtt", "If", "Equals", "And", "Or", "Not", "Select", "Split", "FindInMap", "Join", "Condition", "ImportValue", "GetAZs", "Base64", "Cidr"];

/** Parses CloudFormation YAML (short-form intrinsics) to plain JSON. Rejects anchors/aliases, which CloudFormation does not accept. */
export function loadTemplate(file) {
  const text = fs.readFileSync(file, "utf8");
  if (/^[^#\n]*[\s:\[{,][&*][A-Za-z_]\w*/m.test(text.replace(/"[^"\n]*"/g, '""'))) throw new Error("YAML anchors/aliases are rejected by CloudFormation");
  const seqTags = SHORT.flatMap((name) => [
    { tag: `!${name}`, collection: "seq", resolve: (seq) => ({ [name === "Ref" || name === "Condition" ? name : `Fn::${name}`]: seq.toJSON() }) },
    { tag: `!${name}`, collection: "map", resolve: (map) => ({ [name === "Ref" || name === "Condition" ? name : `Fn::${name}`]: map.toJSON() }) },
    {
      tag: `!${name}`,
      resolve: (str) => {
        if (name === "GetAtt") return { "Fn::GetAtt": String(str).split(".") };
        return { [name === "Ref" || name === "Condition" ? name : `Fn::${name}`]: str };
      },
    },
  ]);
  return parse(text, { customTags: seqTags, schema: "core" });
}

function paramValue(t, params, name) {
  if (name in params) return params[name];
  return t.Parameters?.[name]?.Default;
}

function evalCond(t, params, node) {
  if (typeof node === "boolean") return node;
  if (node.Condition) return evalCond(t, params, t.Conditions[node.Condition]);
  if (node["Fn::And"]) return node["Fn::And"].every((n) => evalCond(t, params, n));
  if (node["Fn::Or"]) return node["Fn::Or"].some((n) => evalCond(t, params, n));
  if (node["Fn::Not"]) return !evalCond(t, params, node["Fn::Not"][0]);
  if (node["Fn::Equals"]) {
    const [a, b] = node["Fn::Equals"].map((x) => value(t, params, x));
    return a === b;
  }
  throw new Error(`condition ${JSON.stringify(node)}`);
}

function value(t, params, x) {
  if (x && typeof x === "object" && x.Ref) return paramValue(t, params, x.Ref);
  return x;
}

/** The template with Fn::If resolved and unselected resources/outputs removed, for one stage. */
export function resolveStage(t, stage, extra = {}) {
  const params = { Stage: stage, ...extra };
  const conds = Object.fromEntries(Object.keys(t.Conditions ?? {}).map((c) => [c, evalCond(t, params, { Condition: c })]));
  const walk = (n) => {
    if (Array.isArray(n)) return n.map(walk).filter((x) => x !== undefined && !(x && x.Ref === "AWS::NoValue"));
    if (n && typeof n === "object") {
      if (n["Fn::If"]) {
        const [c, a, b] = n["Fn::If"];
        return walk(conds[c] ? a : b);
      }
      const out = {};
      for (const [k, v] of Object.entries(n)) {
        const w = walk(v);
        if (w === undefined || (w && w.Ref === "AWS::NoValue")) continue;
        out[k] = w;
      }
      return out;
    }
    return n;
  };
  const resources = {};
  for (const [id, r] of Object.entries(t.Resources)) {
    if (r.Condition && !conds[r.Condition]) continue;
    resources[id] = walk(r);
  }
  return { params, conds, resources };
}

const statements = (doc) => (Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]);
const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

/** Every IAM policy document in a resolved stage. */
export function policyDocs(resources) {
  const docs = [];
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === "AWS::IAM::Role") {
      for (const p of r.Properties.Policies ?? []) docs.push([`${id}/${p.PolicyName}`, p.PolicyDocument]);
    }
  }
  return docs;
}

export function violations(t, stage, extra = {}) {
  const { resources: R, params } = resolveStage(t, stage, extra);
  const v = [];
  const ofType = (type) => Object.entries(R).filter(([, r]) => r.Type === type);

  for (const [id, r] of Object.entries(R)) {
    if (r.Type.startsWith("AWS::EC2::")) v.push(`${id}: EC2/VPC resource (no VPC)`);
    if (r.Properties?.VpcConfig) v.push(`${id}: VpcConfig (no VPC)`);
    if (r.Type === "AWS::CloudFront::OriginAccessControl") v.push(`${id}: OAC (the origin-verify header is the design)`);
    if (r.Type.startsWith("AWS::WAF")) v.push(`${id}: WAF`);
  }

  for (const [id, r] of ofType("AWS::DynamoDB::Table")) {
    const p = r.Properties;
    if (p.BillingMode !== "PAY_PER_REQUEST") v.push(`${id}: not on-demand`);
    if (p.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled !== true) v.push(`${id}: PITR off`);
    if (stage === "prod" && p.DeletionProtectionEnabled !== true) v.push(`${id}: prod without deletion protection`);
    if (stage !== "prod" && p.DeletionProtectionEnabled === true) v.push(`${id}: deletion protection outside prod`);
    if (id === "EphemeralTable" && !(p.TimeToLiveSpecification?.Enabled === true && p.TimeToLiveSpecification.AttributeName === "ttl")) v.push(`${id}: no TTL on ttl`);
  }

  for (const [id, r] of ofType("AWS::Lambda::Function")) {
    const p = r.Properties;
    if (p.Runtime !== "nodejs24.x") v.push(`${id}: runtime ${p.Runtime}`);
    if (JSON.stringify(p.Architectures) !== '["arm64"]') v.push(`${id}: not arm64`);
    if (p.LoggingConfig?.SystemLogLevel !== "WARN" || p.LoggingConfig?.LogFormat !== "JSON") v.push(`${id}: logging not JSON/WARN`);
    if (p.Environment?.Variables?.AKLDB_DDB_ALLOW_REMOTE !== "1" && id !== "MirrorIngestFn") v.push(`${id}: AKLDB_DDB_ALLOW_REMOTE missing`);
  }
  const urlFor = {};
  for (const [id, r] of ofType("AWS::Lambda::Url")) {
    const target = r.Properties.TargetFunctionArn["Fn::GetAtt"][0];
    urlFor[target] = r;
    if (r.Properties.AuthType !== "NONE") v.push(`${id}: AuthType`);
    const want = target === "MirrorIngestFn" ? "BUFFERED" : "RESPONSE_STREAM";
    if (r.Properties.InvokeMode !== want) v.push(`${id}: InvokeMode ${r.Properties.InvokeMode}`);
  }
  for (const f of ["ApiFn", "FeedFn"]) if (!urlFor[f]) v.push(`${f}: no Function URL`);
  if (urlFor.MirrorApplyFn) v.push("MirrorApplyFn: has a Function URL");
  if (urlFor.JobsFn) v.push("JobsFn: has a Function URL");
  for (const [id, r] of ofType("AWS::Lambda::Permission")) {
    if (r.Properties.FunctionName.Ref === "MirrorApplyFn" && r.Properties.Principal === "*") v.push(`${id}: public permission on MirrorApplyFn`);
  }

  // IAM
  for (const [name, doc] of policyDocs(R)) {
    for (const s of statements(doc)) {
      for (const a of arr(s.Action)) if (typeof a === "string" && a.includes("*")) v.push(`${name}: wildcard action ${a}`);
      if (s.Effect === "Allow" && arr(s.Resource).some((x) => x === "*")) v.push(`${name}: Resource *`);
    }
  }

  // Distribution
  for (const [id, r] of ofType("AWS::CloudFront::Distribution")) {
    const c = r.Properties.DistributionConfig;
    const all = [c.DefaultCacheBehavior, ...(c.CacheBehaviors ?? [])];
    for (const b of all) {
      if (b.CachePolicyId !== "4135ea2d-6df8-44a3-9df3-4b5a84be39ad") v.push(`${id}: caching enabled on ${b.PathPattern ?? "default"}`);
      if (b.OriginRequestPolicyId !== "b689b0a8-53d0-40ab-baf2-68738e2966ac") v.push(`${id}: origin request policy`);
    }
    for (const o of c.Origins) if (!arr(o.OriginCustomHeaders).some((h) => h.HeaderName === "X-Origin-Verify")) v.push(`${id}: origin ${o.Id} without X-Origin-Verify`);
    const aliases = c.Aliases ?? [];
    const want = stage === "lab" || !params.CertificateArn ? [] : [stage === "prod" ? "api.akldb.org" : "staging-api.akldb.org"];
    if (JSON.stringify(aliases) !== JSON.stringify(want)) v.push(`${id}: aliases ${JSON.stringify(aliases)}`);
  }

  // Schedules
  const jobs = R.JobsSchedule?.Properties;
  if (!jobs || jobs.ScheduleExpression !== "rate(5 minutes)") v.push("JobsSchedule: rate(5 minutes) missing");
  if (stage === "prod") {
    const a = R.ApplySchedule?.Properties;
    if (!a || a.ScheduleExpression !== "rate(1 minute)") v.push("ApplySchedule: rate(1 minute) missing");
    else if ((params.MirrorMode ?? "apply") === "record" && a.State !== "DISABLED") v.push("ApplySchedule: enabled in record mode");
  }

  // Logs
  const lg = R.LogGroup?.Properties;
  if (!lg || lg.LogGroupClass !== "INFREQUENT_ACCESS" || "RetentionInDays" in lg) v.push("LogGroup: must be INFREQUENT_ACCESS with retention never");

  // Alarms, topics
  const alarms = ofType("AWS::CloudWatch::Alarm").length;
  if (alarms > 10) v.push(`${alarms} alarms (free tier is 10)`);
  for (const [id, r] of ofType("AWS::SNS::TopicPolicy")) {
    const sids = statements(r.Properties.PolicyDocument).map((s) => s.Sid);
    if (sids.some((s) => !s) || new Set(sids).size !== sids.length) v.push(`${id}: every statement needs a unique Sid`);
  }
  if (!ofType("AWS::Budgets::Budget").length !== (stage !== "prod")) v.push("Budget: exactly on prod");

  // Prod-only mirror
  const mirrorIds = ["MirrorIngestFn", "MirrorApplyFn", "MirrorIngestUrl", "ApplySchedule"];
  for (const id of mirrorIds) if ((id in R) !== (stage === "prod")) v.push(`${id}: ${stage === "prod" ? "missing on prod" : "present outside prod"}`);

  const dr = t.Parameters?.DiscordApiUrl?.Default;
  if (dr !== "https://discord.com/api") v.push(`DISCORD_API_URL default ${dr}`);
  return v;
}

export function expectedResources(stage) {
  const common = [
    "MainTable", "EphemeralTable", "DataBucket", "DumpsBucket", "SnapshotBucket", "DataBucketPolicy", "DumpsBucketPolicy", "SnapshotBucketPolicy",
    "LogGroup", "ApiRole", "FeedRole", "JobsRole", "ApiFn", "FeedFn", "JobsFn", "ApiUrl", "FeedUrl",
    "ApiUrlPermission", "ApiInvokePermission", "FeedUrlPermission", "FeedInvokePermission", "Distribution", "SchedulerRole", "JobsSchedule",
    "AlarmTopic", "AlarmTopicPolicy", "ApiErrorsAlarm", "ApiThrottlesAlarm", "JobsErrorsAlarm", "JobsThrottlesAlarm", "DdbSystemErrorsAlarm",
    "DdbThrottlesAlarm", "EventTxRetriesAlarm", "ReplicaStaleAlarm", "DumpStaleAlarm",
  ];
  const prod = [
    "MirrorIngestRole", "MirrorApplyRole", "MirrorIngestFn", "MirrorApplyFn", "MirrorIngestUrl", "MirrorIngestUrlPermission",
    "MirrorIngestInvokePermission", "ApplySchedule", "MirrorDivergedAlarm", "Budget",
  ];
  return [...common, ...(stage === "prod" ? prod : [])].sort();
}
