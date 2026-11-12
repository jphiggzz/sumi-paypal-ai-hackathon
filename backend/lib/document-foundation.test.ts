import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicAddress,
  choosePublicAddress,
  publicDocumentUrl,
  decodePublicDocument,
} from "./public-document";
import {
  uploadInput,
  jobInput,
  feedRead,
  extractFields,
  renderComparison,
} from "./document-policy";
import { CapabilityError } from "./capability-contracts";
const a = "38d115fe-0709-4bb3-9e3e-650f36dfe826",
  b = "1d26e932-fd47-439f-8ffa-1eb111f4cf82";
test("public document URL boundary rejects alternate schemes, encodings, credentials, ports and unapproved hosts", () => {
  assert.equal(
    publicDocumentUrl(
      "https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore",
    ).hostname,
    "raw.githubusercontent.com",
  );
  for (const u of [
    "http://raw.githubusercontent.com/a",
    "https://raw.githubusercontent.com.evil.invalid/a",
    "https://raw.githubusercontent.com@127.0.0.1/a",
    "https://raw.githubusercontent.com:444/a",
    "https://raw.githubusercontent.com/a?token=secret",
    "https://raw.githubusercontent.com/a#anchor",
    "https://raw.githubusercontent.com/a%00",
    "https://127.1/a",
    "https://2130706433/a",
    "https://[::1]/a",
    "https://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
  ])
    assert.throws(
      () => publicDocumentUrl(u),
      (e) => e instanceof CapabilityError && e.code === "PUBLIC_URL_DENIED",
    );
});
test("DNS answers deny private, mapped, metadata, reserved and mixed-address destinations before transport", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.2.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
      "2002:7f00:1::1",
      "3fff::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.ok(publicAddress("8.8.8.8"));
  assert.ok(publicAddress("2606:4700::1111"));
  assert.throws(() =>
    choosePublicAddress([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
  assert.equal(
    choosePublicAddress([
      { address: "2606:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]).family,
    4,
  );
});
test("document decoding accepts bounded inert UTF8 text and rejects binaries, HTML and invalid encodings", () => {
  assert.equal(
    decodePublicDocument(
      Buffer.from("key: value\r\n"),
      "text/plain; charset=utf-8",
    ),
    "key: value\n",
  );
  for (const [body, type] of [
    [Buffer.from("<script>alert(1)</script>"), "text/html"],
    [Buffer.alloc(32769), "text/plain"],
    [Buffer.from([255, 254]), "text/plain"],
    [Buffer.from("bad\0text"), "text/plain"],
    [Buffer.from("text"), "text/plain; charset=iso-8859-1"],
  ] as const)
    assert.throws(() => decodePublicDocument(body, type));
});
test("file and finite job contracts reject credential/tool injection and excessive input/fanout", () => {
  const upload = {
    requestId: a,
    sourceId: b,
    expectedVersion: 0,
    filename: "facts.md",
    content: "label: value",
  };
  assert.ok(uploadInput.safeParse(upload).success);
  for (const p of [
    { filename: "../secret.txt" },
    { filename: "payload.pdf" },
    { content: "\0" },
    { content: "🚀".repeat(9000) },
    { ownerId: "other" },
  ])
    assert.equal(uploadInput.safeParse({ ...upload, ...p }).success, false);
  const job = {
    id: a,
    conversationId: b,
    sources: [
      { id: a, version: 1 },
      { id: b, version: 1 },
    ],
    fields: ["label"],
  };
  assert.ok(jobInput.safeParse(job).success);
  for (const p of [
    {
      sources: [
        { id: a, version: 1 },
        { id: a, version: 1 },
      ],
    },
    { fields: ["label", "LABEL"] },
    { tools: ["send_email"] },
    { goal: "Spend indefinitely" },
    { holdAfterStage: 99 },
  ])
    assert.equal(jobInput.safeParse({ ...job, ...p }).success, false);
  assert.equal(
    feedRead.safeParse({ after: "9223372036854775808" }).success,
    false,
  );
});
test("extraction abstains on absent/contradictory facts and generated comparison uses source-bound references", () => {
  const docs = [
    {
      id: a,
      version: 1,
      title: "one.md",
      content: "unit: meters\nlabel: OLD\nlabel: NEW",
    },
    { id: b, version: 2, title: "two.md", content: "unit=meters\nlabel: NEXT" },
  ];
  const rows = extractFields(docs, ["unit", "label", "missing"]);
  assert.equal(rows[0].facts[1].status, "ambiguous");
  assert.equal(rows[0].facts[2].status, "absent");
  const md = renderComparison(rows, ["unit", "label", "missing"]);
  assert.ok(md.includes(`[source:${a}@1]`));
  assert.match(md, /\| unit \| meters \| meters \| same \|/);
  assert.match(md, /insufficient evidence/);
});

test('pinned transport follows no redirects, forwards no credentials and rejects socket/address changes',async()=>{
 const {EventEmitter}=await import('node:events');const {readPublicDocument}=await import('./public-document');
 async function exercise(status:number,remote='8.8.8.8',headers:Record<string,string>={'content-type':'text/plain'},body='label: SAFE'){
  let requests=0,pinned='';
  const fakeRequest=((url:any,options:any,callback:any)=>{requests++;assert.equal(String(url),'https://raw.githubusercontent.com/example/document/main/a.txt');assert.equal(options.agent,false);assert.equal(options.servername,'raw.githubusercontent.com');assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);options.lookup('raw.githubusercontent.com',{},(_e:any,address:string)=>{pinned=address;});const req:any=new EventEmitter();req.destroy=()=>req.emit('close');req.end=()=>queueMicrotask(()=>{const response:any=new EventEmitter();response.statusCode=status;response.headers=headers;response.socket={remoteAddress:remote};response.destroy=()=>req.emit('close');callback(response);response.emit('data',Buffer.from(body));response.emit('end');req.emit('close');});return req;}) as any;
  const promise=readPublicDocument('https://raw.githubusercontent.com/example/document/main/a.txt',{lookup:(async()=>[{address:'8.8.8.8',family:4}]) as any,request:fakeRequest});return {promise:await promise.then(v=>({value:v,error:null})).catch(e=>({value:null,error:e})),requests,pinned};
 }
 const ok=await exercise(200);assert.equal(ok.promise.value?.content,'label: SAFE');assert.equal(ok.pinned,'8.8.8.8');assert.equal(ok.requests,1);
 const redirect=await exercise(302,'8.8.8.8',{'content-type':'text/plain',location:'https://127.0.0.1/private'});assert.equal(redirect.promise.error?.code,'PUBLIC_REDIRECT_DENIED');assert.equal(redirect.requests,1);
 assert.equal((await exercise(200,'10.0.0.1')).promise.error?.code,'PUBLIC_ADDRESS_CHANGED');
 assert.equal((await exercise(200,'8.8.8.8',{'content-type':'text/plain','content-length':'32769'})).promise.error?.code,'PUBLIC_BODY_LIMIT');
 assert.equal((await exercise(200,'8.8.8.8',{'content-type':'text/plain'},'x'.repeat(32769))).promise.error?.code,'PUBLIC_BODY_LIMIT');
});

test('public throttling preserves numeric and HTTP-date backoff without early retry',async()=>{const {publicRetryAfter}=await import('./public-document');const now=Date.parse('2026-11-09T12:00:00Z');assert.equal(publicRetryAfter('300',now),300000);assert.equal(publicRetryAfter('Mon, 09 Nov 2026 12:02:00 GMT',now),120000);assert.equal(publicRetryAfter('invalid',now),1000);});
