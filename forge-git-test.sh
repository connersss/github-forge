#!/bin/bash
# Full git-surface test against the forge on localhost:18099.
# Usage: bash /tmp/forge-git-test.sh
set -u
BASE=http://localhost:18099
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got [$2] want [$3])"; fi; }

curl -s -X POST $BASE/api/v3/user/repos -H 'Content-Type: application/json' -d '{"name":"demo2"}' -o /dev/null -w "create repo: %{http_code}\n"

rm -rf /tmp/g2 && mkdir -p /tmp/g2 && cd /tmp/g2 || exit 1
git -c protocol.version=2 clone $BASE/adaiversen/demo2.git w1 2>&1 | grep -q "empty repository" && ok "clone empty" || bad "clone empty"
cd w1 || exit 1
git config user.email t@t.t; git config user.name t
printf 'hello world\nline two\n' > hello.txt
mkdir -p src && printf 'code\n' > src/main.txt
git add . && git commit -qm "first commit"
git push origin main 2>&1 | grep -q "main -> main" && ok "push first commit" || bad "push first commit"
printf 'more\n' >> hello.txt && git add . && git commit -qm "second commit"
git push origin main 2>&1 | grep -q "main -> main" && ok "push second commit" || bad "push second commit"
git tag -a v1 -m "release v1"
git push origin v1 2>&1 | grep -q "new tag" && ok "push annotated tag" || bad "push annotated tag"
git checkout -qb feature && printf 'feature work\n' > feat.txt && git add . && git commit -qm "feature commit"
git push origin feature 2>&1 | grep -q "new branch" && ok "push new branch" || bad "push new branch"
# non-fast-forward must be refused
git reset -q --hard HEAD~1 && printf 'diverged\n' > feat.txt && git add . && git commit -qm "diverged commit"
if git push origin feature 2>&1 | grep -q "non-fast-forward"; then ok "push non-fast-forward refused"; else bad "push non-fast-forward refused"; fi
# delete the branch, then recreate it from main
git push origin :feature 2>&1 | grep -q "deleted" && ok "push delete branch" || bad "push delete branch"
git checkout -q main && git checkout -qb feature2 && git push origin feature2 2>&1 | grep -q "new branch" && ok "push branch after delete" || bad "push branch after delete"

cd /tmp/g2 || exit 1
git -c protocol.version=2 clone $BASE/adaiversen/demo2.git w2 2>&1 | grep -q "Cloning" && ok "clone full" || bad "clone full"
cd w2 || exit 1
check "clone log has 2 commits" "$(git log --oneline | wc -l)" "2"
check "clone hello.txt" "$(cat hello.txt)" "hello world
line two
more"
check "clone tag v1" "$(git tag -l)" "v1"
check "clone has feature2" "$(git branch -a | grep -c feature2)" "1"
git fsck 2>&1 | grep -q "dangling\|missing\|error" && bad "fsck clean" || ok "fsck clean"
# incremental fetch: add a commit in w1, fetch in w2
cd /tmp/g2/w1 && git checkout -q main && printf 'third\n' >> hello.txt && git add . && git commit -qm "third commit" && git push origin main 2>&1 | grep -q "main -> main" && ok "push third commit" || bad "push third commit"
cd /tmp/g2/w2 && git fetch origin 2>&1 | grep -q "a0d25b4\|->" && ok "incremental fetch" || bad "incremental fetch"
check "fetch got new commit" "$(git log --oneline origin/main | head -1 | cut -d' ' -f2-)" "third commit"
git fetch origin >/dev/null 2>&1 && ok "fetch nothing new" || bad "fetch nothing new"
# shallow clone depth 1
cd /tmp/g2 && git clone --depth 1 $BASE/adaiversen/demo2.git w3 2>&1 | grep -q "Cloning" && ok "shallow clone" || bad "shallow clone"
check "shallow has 1 commit" "$(cd w3 && git log --oneline | wc -l)" "1"
check "shallow file content" "$(cd w3 && cat hello.txt)" "hello world
line two
more
third"
# deepen the shallow clone
cd w3 && git fetch --deepen=1 origin >/dev/null 2>&1 && ok "shallow deepen" || bad "shallow deepen"
check "deepen has 2 commits" "$(git log --oneline | wc -l)" "2"
# shallow fetch of a new tip: add a 4th commit, fetch --depth 1 in w3
cd /tmp/g2/w1 && printf 'fourth\n' >> hello.txt && git add . && git commit -qm "fourth commit" && git push origin main 2>&1 | grep -q "main -> main" && ok "push fourth commit" || bad "push fourth commit"
cd /tmp/g2/w3 && git fetch --depth 1 origin main >/dev/null 2>&1 && ok "shallow fetch new tip" || bad "shallow fetch new tip"
check "shallow fetch tip content" "$(git show origin/main:hello.txt | tail -1)" "fourth"
# 100-file push
cd /tmp/g2/w1 && git checkout -q main && mkdir -p many && for i in $(seq 1 100); do printf "file %s\n" "$i" > "many/f$i.txt"; done && git add . && git commit -qm "100 files" && git push origin main 2>&1 | grep -q "main -> main" && ok "push 100 files" || bad "push 100 files"
cd /tmp/g2 && git clone -q $BASE/adaiversen/demo2.git w4 2>&1 && check "100 files round-trip" "$(cd w4 && ls many | wc -l)" "100"
check "100 files content" "$(cd w4 && cat many/f42.txt)" "file 42"

echo "=== $PASS passed, $FAIL failed ==="
