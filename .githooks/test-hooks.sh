#!/bin/bash
# Tests for the pre-push gate. Run this after touching the hook.
#
# The reason this file exists: for weeks .git/hooks/pre-push was a symlink that
# core.hooksPath would have silently disabled, while two documents claimed a guard was
# enforced. The existence of a guard is not evidence that it runs. Every case below
# builds a throwaway repository, pushes to a local bare remote, and reads the outcome.
set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/pre-push"
POLICY="$(cd "$(dirname "$0")/.." && pwd)/.gitleaks.toml"
pass=0; fail=0
ok()   { printf '\033[32m  ok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '\033[31m  FAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# $1=name  $2=expect(block|allow)  $3=setup function
run_case() {
  local name="$1" expect="$2" setup="$3"
  local repo="$work/$(echo "$name" | tr -cd '[:alnum:]')"
  local bare="$repo.git"
  rm -rf "$repo" "$bare"
  git init -q --bare "$bare"
  git init -q "$repo"
  (
    cd "$repo" || exit 1
    git config user.email "t@example.com"
    git config user.name "Tester"
    git config core.hooksPath .githooks
    mkdir -p .githooks
    cp "$HOOK" .githooks/pre-push
    chmod +x .githooks/pre-push
    [ -f "$POLICY" ] && cp "$POLICY" .gitleaks.toml
    touch .clean-room
    "$setup"
    git add -A >/dev/null 2>&1
    git commit -qm "case" >/dev/null 2>&1
    git remote add origin "$bare"
    git push -q origin HEAD:refs/heads/main >/dev/null 2>&1
  )
  local rc=$?
  if [ "$expect" = "block" ]; then
    [ "$rc" -ne 0 ] && ok "$name" || bad "$name (expected block, push succeeded)"
  else
    [ "$rc" -eq 0 ] && ok "$name" || bad "$name (expected allow, push blocked)"
  fi
}

# --- must BLOCK ---------------------------------------------------------------
s_supabase_key()  { printf 'const k = "sb_\x73ecret_x7Kq2mB9vTz4Lw8nRc3JdHf6";\n' > src.ts; }
s_account_id()    { printf 'account_id = "9f3b7c1e42a08d65be91437fc0a2d5e8"\n' > infra.txt; }
s_project_ref()   { printf 'const u = "https://qwrtyplkjhgfdsazxcvb.supabase.co";\n' > db.ts; }
s_turkish()       { printf '// deger yoksa varsayilana d\xc3\xbc\xc5\x9f\xc3\xbclur\nexport const x = 1;\n' > tr.ts; }
# The next three build their fixture from escapes rather than literals. A test for a
# forbidden term cannot spell that term out: this file is committed to the public
# repository the term is being kept out of, and the gate would refuse its own test suite.
s_person()        { printf '// asked for by \x42urak\nexport const y = 2;\n' > who.ts; }
s_vessel()        { printf 'const boat = "\x4cady \x4aade";\n' > boat.ts; }
s_ai_signature()  { printf '# notes\n\nCo-\x41uthored-\x42y: \x43laude\n' > NOTES.md; }
s_private_repo()  { printf 'const r = "sip\x61ru-ops";\n' > infra2.ts; }
s_db_role()       { printf 'const key = process.env.%sice_role;\n' 'serv' > sr.ts; }
s_emdash()        { printf 'export const t = "sealed \xe2\x80\x94 always";\n' > dash.ts; }
s_forbidden_path(){ printf 'private notes\n' > CLAUDE.md; }
s_docs_private()  { mkdir -p docs-private && printf 'internal\n' > docs-private/plan.md; }
s_scripts_path()  { mkdir -p scripts && printf 'echo hi\n' > scripts/tool.sh; }
# Personal data, built from escapes for the same reason the names above are.
s_email()         { printf 'maintainer: j\x64oe@gm\x61il.com\n' > contact.txt; }
s_phone()         { printf 'call \x2b44 20 7946 0958\n' > support.md; }
s_mmsi_real()     { printf 'mmsi: 24\x34123456\n' > vessel.ts; }
# A track outside the sandbox: coastal coordinates, one hundred and fifty of them. The
# constants in this generator are two points, which is not a track; what it WRITES is.
s_track_coastal() {
  awk 'BEGIN{for(i=0;i<150;i++) printf "{\"lat\":%.5f,\"lon\":%.5f}\n", 43.5+i/10000, 7.0+i/10000}' \
    > fixture.ndjson
}
# The same coastal track, gzipped: the form the original leak actually travelled in.
s_track_gzipped() { s_track_coastal && gzip -f fixture.ndjson; }

run_case "supabase secret key is blocked"        block s_supabase_key
run_case "cloudflare account id is blocked"      block s_account_id
run_case "supabase project ref is blocked"       block s_project_ref
run_case "accented native-language text blocked" block s_turkish
run_case "personal name is blocked"              block s_person
run_case "vessel name is blocked"                block s_vessel
run_case "AI co-author signature is blocked"     block s_ai_signature
run_case "private repository name is blocked"    block s_private_repo
run_case "privileged db role reference blocked"  block s_db_role
run_case "em dash is blocked"                    block s_emdash
run_case "tracked CLAUDE.md is blocked"          block s_forbidden_path
run_case "tracked docs-private/ is blocked"      block s_docs_private
run_case "tracked scripts/ is blocked"           block s_scripts_path
run_case "email address is blocked"              block s_email
run_case "dialable phone number is blocked"      block s_phone
run_case "real-shaped MMSI is blocked"           block s_mmsi_real
run_case "coastal track is blocked"              block s_track_coastal
run_case "gzipped coastal track is blocked"      block s_track_gzipped

# --- must ALLOW (a gate that cries wolf gets switched off) --------------------
a_plain()      { printf 'export const version = "0.1.42";\n' > ok.ts; }
a_loopback()   { printf 'const dev = "http://localhost:3000";\n' > dev.ts; }
a_placeholder(){ printf 'account_id = "<YOUR_ACCOUNT_ID>"\n' > example.txt; }
a_coordinate() { printf 'const lat = 43.5528; const lon = 7.0174;\n' > vector.ts; }
a_localprop()  { printf 'const v = cfg.local ?? cfg.remote;\n' > cfg.ts; }
a_ascii_only() { printf '// keep this in English, no accents\nexport const z = 3;\n' > en.ts; }
a_hyphen()     { printf 'const range = "0-360 degrees";\n' > deg.ts; }
a_readme_dot() { printf 'Chart data \xc2\xb7 OpenStreetMap contributors\n' > README.md; }
a_noreply()    { printf 'author: 257530405+Tjockfan@users.noreply.github.com\n' > AUTHORS; }
a_product_mail(){ printf 'write to support@siparu.app\n' > SUPPORT.md; }
a_mmsi_fake()  { printf "const SELF = 'vessels.urn:mrn:imo:mmsi:111111111'\n" > rig.ts; }
a_track_ocean() {
  awk 'BEGIN{for(i=0;i<150;i++) printf "{\"lat\":%.5f,\"lon\":%.5f}\n", 35.0-i/10000, -40.0+i/10000}' \
    > fixture.ndjson
}
a_semver_build(){ printf 'version 2.0.0+20130313144700 shipped\n' > CHANGES.md; }

run_case "ordinary source is allowed"            allow a_plain
run_case "localhost is allowed"                  allow a_loopback
run_case "documentation placeholder is allowed"  allow a_placeholder
run_case "test-vector coordinate is allowed"     allow a_coordinate
run_case "cfg.local property access is allowed"  allow a_localprop
run_case "plain ASCII English is allowed"        allow a_ascii_only
run_case "hyphen range is allowed"               allow a_hyphen
run_case "middot in attribution is allowed"      allow a_readme_dot
run_case "noreply git identity is allowed"       allow a_noreply
run_case "product support address is allowed"    allow a_product_mail
run_case "synthetic MMSI rig is allowed"         allow a_mmsi_fake
run_case "open-ocean synthetic track is allowed" allow a_track_ocean
run_case "semver build metadata is allowed"      allow a_semver_build

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
