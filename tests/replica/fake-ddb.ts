// A tiny in-process DynamoDB for the log's JSON API (GetItem, Query on the LOG partition, TransactWriteItems with the
// log's two conditions), handed to createDdbLog as its `fetch`. Enough to run the image entry through the real DynamoDB
// log code without Docker or a port. It counts the calls so a test can prove a refusal happened before any request.
type Attr = { S?: string; N?: string };
type Item = Record<string, Attr>;

export class FakeDdb {
  readonly items = new Map<string, Item>();
  readonly calls: string[] = [];
  readonly fetch = async (request: Request): Promise<Response> => {
    const target = (request.headers.get("x-amz-target") ?? "").replace("DynamoDB_20120810.", "");
    this.calls.push(target);
    const body = JSON.parse(await request.text()) as Record<string, any>;
    return this.handle(target, body);
  };

  #key(k: { pk: Attr; sk: Attr }): string {
    return `${k.pk.S}|${k.sk.S}`;
  }

  #json(status: number, v: unknown): Response {
    return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/x-amz-json-1.0" } });
  }

  handle(target: string, body: Record<string, any>): Response {
    if (target === "GetItem") {
      const it = this.items.get(this.#key(body.Key));
      return this.#json(200, it === undefined ? {} : { Item: it });
    }
    if (target === "Query") {
      const v = body.ExpressionAttributeValues as Record<string, Attr>;
      const out = [...this.items.values()]
        .filter((it) => it.pk!.S === v[":pk"]!.S && it.sk!.S! >= v[":lo"]!.S! && it.sk!.S! <= v[":hi"]!.S!)
        .sort((a, b) => a.sk!.S!.localeCompare(b.sk!.S!));
      return this.#json(200, { Items: out });
    }
    if (target === "TransactWriteItems") {
      const [put, upd] = body.TransactItems as { Put: { Item: Item }; Update: { Key: { pk: Attr; sk: Attr }; ExpressionAttributeValues: Record<string, Attr> } }[];
      const key = this.#key(put!.Put.Item as never);
      const head = this.items.get(this.#key(upd!.Update.Key));
      const cur = upd!.Update.ExpressionAttributeValues[":cur"]!.N!;
      const reasons = [this.items.has(key) ? "ConditionalCheckFailed" : "None", head !== undefined && head.seq!.N !== cur ? "ConditionalCheckFailed" : "None"];
      if (reasons.some((r) => r !== "None")) return this.#json(400, { __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException", message: "cancelled", CancellationReasons: reasons.map((Code) => ({ Code })) });
      this.items.set(key, put!.Put.Item);
      this.items.set(this.#key(upd!.Update.Key), { pk: { S: "HEAD" }, sk: { S: "HEAD" }, seq: upd!.Update.ExpressionAttributeValues[":next"]! });
      return this.#json(200, {});
    }
    return this.#json(400, { __type: "UnknownOperationException", message: target });
  }
}
