#!/usr/bin/env node
// issue-sync: repo issues ↔ GitHub Project V2 单向对齐 + 漂移检查。
// 纪律：任何 issue 创建/关闭/改里程碑后，必须跑 `node scripts/issue-sync.mjs sync`。
// 用法：node scripts/issue-sync.mjs check   # 只报告漂移，不改任何东西
//       node scripts/issue-sync.mjs sync    # 对齐：入板、按 issue state 设 Status（open→Todo, closed→Done）
import { execFileSync } from "node:child_process";

const OWNER = "Samuka007";
const REPO = "cloudflare-agent-project";
const PROJECT_NUMBER = 5;
const MODE = process.argv[2] === "check" ? "check" : process.argv[2] === "sync" ? "sync" : null;
if (!MODE) { console.error("usage: node scripts/issue-sync.mjs check|sync"); process.exit(2); }

const gh = (args, input) =>
  execFileSync("gh", args, { input: input ?? undefined, encoding: "utf8", maxBuffer: 1 << 24 });

const gql = (query, variables = {}) => {
  const out = gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  const r = JSON.parse(out);
  if (r.errors || !r.data) throw new Error(`graphql failed: ${out.slice(0, 500)}`);
  return r.data;
};

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// 1. repo 全量 issue（REST 列表才有 GraphQL node_id；过滤 PR）
const issues = JSON.parse(gh(["api", `repos/${OWNER}/${REPO}/issues?state=all&per_page=100`,
  "--jq", `map(select(.pull_request == null)) | map({number, state: (.state | ascii_upcase), milestone: (if .milestone then .milestone.title else null end), node_id})`]));

// 2. project id + Status 字段 + 现有 items（分页）
const PAGE = `items(first:100, after:$cursor){ pageInfo{ hasNextPage endCursor }
        nodes{ id content{ ... on Issue{ number state } }
          status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } }`;
let cursor = null, projectId, statusField, itemNodes = [];
for (;;) {
  const v = { owner: OWNER, num: PROJECT_NUMBER, cursor };
  if (cursor === null) delete v.cursor;
  const r = gql(
    `query($owner:String!,$num:Int!,$cursor:String){
      user(login:$owner){ projectV2(number:$num){
        id
        field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } }
        ${PAGE}
      } }
    }`, v).user.projectV2;
  projectId = r.id;
  statusField = r.field;
  itemNodes.push(...r.items.nodes);
  if (!r.items.pageInfo.hasNextPage) break;
  cursor = r.items.pageInfo.endCursor;
}
const statusByState = Object.fromEntries(statusField.options.map(o => [o.name.toLowerCase(), o.id]));
const inProject = new Map(itemNodes.filter(n => n.content?.number).map(n => [n.content.number, n.id]));

// 3. 计划：milestone 非空的 issue 都应在板上，Status 跟随 issue state
const wanted = issues.filter(i => i.milestone);
const plan = [];
for (const i of wanted) {
  if (!inProject.has(i.number)) plan.push({ op: "add", n: i.number, issue: i });
  else {
    const boardState = itemNodes.find(n => n.id === inProject.get(i.number))?.content?.state;
    const boardStatus = itemNodes.find(n => n.id === inProject.get(i.number))?.status?.name;
    const expected = i.state === "CLOSED" ? "Done" : "Todo";
    if (boardState !== i.state || boardStatus !== expected)
      plan.push({ op: "status", n: i.number, itemId: inProject.get(i.number), issue: i });
  }
}

if (MODE === "check") {
  if (plan.length === 0) { console.log("OK: project in sync"); process.exit(0); }
  console.log(`DRIFT: ${plan.length} 项待对齐；缺票: ${wanted.filter(i => !inProject.has(i.number)).map(i => "#" + i.number).join(", ") || "无"}`);
  for (const p of plan) console.log(`  ${p.op} #${p.n}${p.op === "status" ? " (state mismatch)" : ""}`);
  process.exit(1);
}

const setStatus = (itemId, state) =>
  gql(`mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
    updateProjectV2ItemFieldValue(input:{projectId:$p, itemId:$i, fieldId:$f, value:{singleSelectOptionId:$o}}){
      projectV2Item{ id } } }`,
    { p: projectId, i: itemId, f: statusField.id, o: statusByState[state === "CLOSED" ? "done" : "todo"] });

for (const p of plan) {
  if (p.op === "add") {
    await sleep(600); // GraphQL secondary rate limit on bulk add
    const r = gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p, contentId:$c}){ item{ id } } }`,
      { p: projectId, c: p.issue.node_id });
    setStatus(r.addProjectV2ItemById.item.id, p.issue.state);
    console.log(`added #${p.n} (status=${p.issue.state === "CLOSED" ? "Done" : "Todo"})`);
  } else {
    setStatus(p.itemId, p.issue.state);
    console.log(`status #${p.n} → ${p.issue.state === "CLOSED" ? "Done" : "Todo"}`);
  }
}
console.log(plan.length ? "synced" : "already in sync");
