#!/usr/bin/env bash
# REST / GraphQL / MCP smoke tests for the forge (server on :18099, no token).
BASE=http://localhost:18099
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { # check <name> <got> <want>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got [$2] want [$3])"; fi
}
jget() { # jget <json> <jq-expr>
  echo "$1" | jq -r "$2" 2>/dev/null
}

# ---- protocol / root ----
R=$(curl -s -i $BASE/api/v3/ | tr -d '\r')
check "root status 200" "$(echo "$R" | head -1 | grep -c '200')" "1"
check "root scopes header" "$(echo "$R" | grep -i 'x-oauth-scopes' | grep -c 'repo')" "1"
check "root request-id" "$(echo "$R" | grep -ci 'x-github-request-id')" "1"
check "meta version" "$(curl -s $BASE/api/v3/meta | jq -r '.installed_version != null')" "true"
check "unknown route 404 json" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v3/nope)" "404"
check "unknown route json body" "$(curl -s $BASE/api/v3/nope | jq -r '.message != null')" "true"
check "malformed json 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/user/repos -H 'Content-Type: application/json' -d '{bad')" "400"
check "user login" "$(curl -s $BASE/api/v3/user | jq -r .login)" "adaiversen"

# ---- repos ----
check "create repo 201" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/user/repos -H 'Content-Type: application/json' -d '{"name":"demo","description":"d1"}')" "201"
check "create dup 422" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/user/repos -H 'Content-Type: application/json' -d '{"name":"demo"}')" "422"
check "get repo" "$(curl -s $BASE/api/v3/repos/adaiversen/demo | jq -r .name)" "demo"
check "get repo default_branch" "$(curl -s $BASE/api/v3/repos/adaiversen/demo | jq -r .default_branch)" "main"
check "get missing repo 404" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v3/repos/adaiversen/nope)" "404"
check "patch repo desc" "$(curl -s -X PATCH $BASE/api/v3/repos/adaiversen/demo -H 'Content-Type: application/json' -d '{"description":"d2"}' | jq -r .description)" "d2"

# ---- contents on unborn repo (first commit) ----
B64=$(printf 'hello forge\n' | base64 -w0)
R=$(curl -s -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt -H 'Content-Type: application/json' -d "{\"message\":\"first\",\"content\":\"$B64\"}")
check "put contents first commit 201" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/second.txt -H 'Content-Type: application/json' -d "{\"message\":\"second\",\"content\":\"$B64\"}")" "201"
check "create branch ref 201" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/repos/adaiversen/demo/git/refs -H 'Content-Type: application/json' -d "{\"ref\":\"refs/heads/feature\",\"sha\":\"$(curl -s $BASE/api/v3/repos/adaiversen/demo/branches | jq -r '.[0].commit.sha')\"}")" "201"
check "get contents" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt | jq -r '.content' | base64 -d)" "hello forge"
check "get contents sha is blob" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt | jq -r '.sha' | grep -cE '^[0-9a-f]{40}$')" "1"
SHA=$(curl -s $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt | jq -r .sha)
B64B=$(printf 'hello forge v2\n' | base64 -w0)
check "put contents stale sha 409" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt -H 'Content-Type: application/json' -d "{\"message\":\"upd\",\"content\":\"$B64B\",\"sha\":\"1111111111111111111111111111111111111111\"}")" "409"
check "put contents update 200" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt -H 'Content-Type: application/json' -d "{\"message\":\"upd\",\"content\":\"$B64B\",\"sha\":\"$SHA\"}")" "200"
check "get updated contents" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt | jq -r '.content' | base64 -d)" "hello forge v2"
check "get dir listing" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/contents/ | jq -r 'type')" "array"
check "branches list" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/branches | jq -r 'length')" "2"
check "commits list" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/commits | jq -r 'length')" "3"
check "delete contents 200" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $BASE/api/v3/repos/adaiversen/demo/contents/second.txt -H 'Content-Type: application/json' -d "{\"message\":\"rm\",\"sha\":\"$(curl -s $BASE/api/v3/repos/adaiversen/demo/contents/second.txt | jq -r .sha)\"}")" "200"
check "deleted contents 404" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v3/repos/adaiversen/demo/contents/second.txt)" "404"

# ---- issues ----
check "create label 201" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/repos/adaiversen/demo/labels -H 'Content-Type: application/json' -d '{"name":"bug","color":"ff0000"}')" "201"
R=$(curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/issues -H 'Content-Type: application/json' -d '{"title":"first issue","body":"body1","labels":["bug"]}')
check "create issue number 1" "$(jget "$R" .number)" "1"
check "create issue state open" "$(jget "$R" .state)" "open"
check "create issue unknown label 422" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/repos/adaiversen/demo/issues -H 'Content-Type: application/json' -d '{"title":"x","labels":["nope"]}' )" "422"
curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/issues -H 'Content-Type: application/json' -d '{"title":"second issue","body":"body2"}' >/dev/null
check "list issues open" "$(curl -s "$BASE/api/v3/repos/adaiversen/demo/issues?state=open" | jq -r 'length')" "2"
check "get issue" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/issues/1 | jq -r .title)" "first issue"
check "close issue" "$(curl -s -X PATCH $BASE/api/v3/repos/adaiversen/demo/issues/1 -H 'Content-Type: application/json' -d '{"state":"closed"}' | jq -r .state)" "closed"
check "list issues open after close" "$(curl -s "$BASE/api/v3/repos/adaiversen/demo/issues?state=open" | jq -r 'length')" "1"
check "list issues sort desc" "$(curl -s "$BASE/api/v3/repos/adaiversen/demo/issues?sort=created&direction=desc" | jq -r '.[0].number')" "2"
check "comment create" "$(curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/issues/2/comments -H 'Content-Type: application/json' -d '{"body":"hi"}' | jq -r .body)" "hi"
check "comment list" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/issues/2/comments | jq -r 'length')" "1"

# ---- pulls ----
MAIN_SHA=$(curl -s $BASE/api/v3/repos/adaiversen/demo/branches | jq -r '.[] | select(.name=="main") | .commit.sha')
check "create branch for pr" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/repos/adaiversen/demo/git/refs -H 'Content-Type: application/json' -d "{\"ref\":\"refs/heads/pr1\",\"sha\":\"$MAIN_SHA\"}")" "201"
# change a file on pr1 branch
B64C=$(printf 'hello pr\n' | base64 -w0)
SHA2=$(curl -s "$BASE/api/v3/repos/adaiversen/demo/contents/hello.txt?ref=pr1" | jq -r .sha)
curl -s -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt -H 'Content-Type: application/json' -d "{\"message\":\"pr change\",\"content\":\"$B64C\",\"branch\":\"pr1\",\"sha\":\"$SHA2\"}" >/dev/null
R=$(curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/pulls -H 'Content-Type: application/json' -d '{"title":"my pr","head":"pr1","base":"main"}')
check "create pull number 1" "$(jget "$R" .number)" "1"
check "create pull state open" "$(jget "$R" .state)" "open"
check "pull files" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/pulls/1/files | jq -r '.[0].filename')" "hello.txt"
check "pull files additions" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/pulls/1/files | jq -r '.[0].additions >= 1')" "true"
check "dup pull 422" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v3/repos/adaiversen/demo/pulls -H 'Content-Type: application/json' -d '{"title":"dup","head":"pr1","base":"main"}')" "422"
check "merge pull squash" "$(curl -s -X PUT $BASE/api/v3/repos/adaiversen/demo/pulls/1/merge -H 'Content-Type: application/json' -d '{"merge_method":"squash"}' | jq -r .merged)" "true"
check "pull merged state" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/pulls/1 | jq -r .state)" "closed"
check "merged content on main" "$(curl -s $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt | jq -r '.content' | base64 -d)" "hello pr"

# ---- merge conflict: two branches change same file differently ----
BASE_SHA=$(curl -s $BASE/api/v3/repos/adaiversen/demo/branches | jq -r '.[] | select(.name=="main") | .commit.sha')
curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/git/refs -H 'Content-Type: application/json' -d "{\"ref\":\"refs/heads/c1\",\"sha\":\"$BASE_SHA\"}" >/dev/null
curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/git/refs -H 'Content-Type: application/json' -d "{\"ref\":\"refs/heads/c2\",\"sha\":\"$BASE_SHA\"}" >/dev/null
SH=$(curl -s "$BASE/api/v3/repos/adaiversen/demo/contents/hello.txt?ref=c1" | jq -r .sha)
curl -s -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt -H 'Content-Type: application/json' -d "{\"message\":\"c1\",\"content\":\"$(printf 'c1\n' | base64 -w0)\",\"branch\":\"c1\",\"sha\":\"$SH\"}" >/dev/null
SH=$(curl -s "$BASE/api/v3/repos/adaiversen/demo/contents/hello.txt?ref=c2" | jq -r .sha)
curl -s -X PUT $BASE/api/v3/repos/adaiversen/demo/contents/hello.txt -H 'Content-Type: application/json' -d "{\"message\":\"c2\",\"content\":\"$(printf 'c2\n' | base64 -w0)\",\"branch\":\"c2\",\"sha\":\"$SH\"}" >/dev/null
curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/pulls -H 'Content-Type: application/json' -d '{"title":"p2","head":"c1","base":"main"}' >/dev/null
curl -s -X POST $BASE/api/v3/repos/adaiversen/demo/pulls -H 'Content-Type: application/json' -d '{"title":"p3","head":"c2","base":"main"}' >/dev/null
check "merge first conflicting pr 200" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/v3/repos/adaiversen/demo/pulls/2/merge -H 'Content-Type: application/json' -d '{"merge_method":"squash"}')" "200"
check "merge second conflicting pr 405" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/v3/repos/adaiversen/demo/pulls/3/merge -H 'Content-Type: application/json' -d '{"merge_method":"squash"}')" "405"

# ---- pagination: 30 repos ----
for i in $(seq 1 30); do curl -s -X POST $BASE/api/v3/user/repos -H 'Content-Type: application/json' -d "{\"name\":\"pg$i\"}" >/dev/null; done
R=$(curl -s -i "$BASE/api/v3/user/repos?per_page=10" | tr -d '\r')
check "pagination link header" "$(echo "$R" | grep -ci 'link:.*rel=\"next\"')" "1"
check "pagination page size 10" "$(echo "$R" | tail -n +$(echo "$R" | grep -n '^\[' | head -1 | cut -d: -f1) | jq -r 'length')" "10"
# follow the chain
NEXT=$(echo "$R" | grep -i '^link:' | sed -E 's/.*<([^>]+)>; rel="next".*/\1/')
check "pagination page2 size" "$(curl -s "$NEXT" | jq -r 'length')" "10"

# ---- delete repo ----
check "delete repo 204" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $BASE/api/v3/repos/adaiversen/pg1)" "204"
check "deleted repo 404" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v3/repos/adaiversen/pg1)" "404"

# ---- GraphQL ----
GQL() { curl -s -X POST $BASE/api/graphql -H 'Content-Type: application/json' -d "$1"; }
check "gql viewer login" "$(GQL '{"query":"query ViewerLogin { viewer { login}}"}' | jq -r '.data.viewer.login')" "adaiversen"
check "gql repository" "$(GQL '{"query":"query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { name owner { login } viewerPermission hasIssuesEnabled }}","variables":{"owner":"adaiversen","name":"demo"}}' | jq -r '.data.repository.name')" "demo"
check "gql repository permission" "$(GQL '{"query":"query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { viewerPermission }}","variables":{"owner":"adaiversen","name":"demo"}}' | jq -r '.data.repository.viewerPermission')" "ADMIN"
check "gql issue type fields" "$(GQL '{"query":"query Issue_fields { Issue: __type(name: \"Issue\") { fields(includeDeprecated: true) { name}}} "}' | jq -r '.data.Issue.fields | map(.name) | contains(["id","number","title","state","body"])')" "true"
check "gql searchtype enum" "$(GQL '{"query":"query SearchType_enumValues { SearchType: __type(name: \"SearchType\") { enumValues(includeDeprecated: true) { name}}} "}' | jq -r '.data.SearchType.enumValues | map(.name) | contains(["ISSUE"])')" "true"
check "gql unknown repo null" "$(GQL '{"query":"query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { name }}","variables":{"owner":"adaiversen","name":"nope"}}' | jq -r '.data.repository')" "null"
check "gql invalid field errors" "$(GQL '{"query":"query ViewerInvalidField { viewer { login noSuchFieldOnViewer}}"}' | jq -r '.errors[0].message | contains("noSuchFieldOnViewer")')" "true"
check "gql batch 2 docs" "$(GQL '[{"query":"query ViewerLogin { viewer { login}}"},{"query":"query ViewerLogin { viewer { login}}"}]' | jq -r 'length')" "2"
REPOID=$(GQL '{"query":"query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId }}","variables":{"owner":"adaiversen","name":"demo"}}' | jq -r '.data.repository.id')
check "gql repo id opaque" "$(echo "$REPOID" | grep -vcE '^[0-9]+$')" "1"
check "gql node repo" "$(GQL "{\"query\":\"query NodeRepository(\$id: ID!) { node(id: \$id) { id ... on Repository { name nameWithOwner}}}\",\"variables\":{\"id\":\"$REPOID\"}}" | jq -r '.data.node.name')" "demo"
check "gql createIssue" "$(GQL "{\"query\":\"mutation { createIssue(input: {repositoryId: \\\"$REPOID\\\", title: \\\"gql issue\\\", body: \\\"gb\\\"}) { issue { number title }}}\"}" | jq -r '.data.createIssue.issue.title')" "gql issue"
check "gql issues list" "$(GQL '{"query":"query OpenIssues($first: Int!) { repository(owner: \"adaiversen\", name: \"demo\") { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state }}}}","variables":{"first":10}}' | jq -r '.data.repository.issues.nodes | length >= 1')" "true"

# ---- MCP ----
MCP() { curl -s -X POST $BASE/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$1"; }
check "mcp discover" "$(MCP '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}' | jq -r '.result != null')" "true"
check "mcp initialize" "$(MCP '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | jq -r '.result.serverInfo != null')" "true"
check "mcp tools list >=6" "$(MCP '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq -r '.result.tools | length >= 6')" "true"
check "mcp tools list idempotent" "$(MCP '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}' | md5sum | cut -d' ' -f1)" "$(MCP '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}' | md5sum | cut -d' ' -f1)"
check "mcp create_issue" "$(MCP '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_issue","arguments":{"owner":"adaiversen","repo":"demo","title":"mcp issue"}}}' | jq -r '.result.content[0].text | fromjson | .number')" "4"
check "mcp list_issues" "$(MCP '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_issues","arguments":{"owner":"adaiversen","repo":"demo"}}}' | jq -r '.result.content[0].text | fromjson | length >= 1')" "true"
check "mcp unknown tool" "$(MCP '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope_tool","arguments":{}}}' | jq -r '.error.code')" "-32602"
check "mcp parse error" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{not json')" "400"
check "mcp missing args" "$(MCP '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_issue","arguments":{}}}' | jq -r '(.result.isError == true) or (.error.code == -32602)')" "true"

echo "=== $PASS passed, $FAIL failed ==="
