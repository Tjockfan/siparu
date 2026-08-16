#!/bin/bash
# Clean-room scan over the PUBLISHED file set, not the tracked one.
#
# Why this exists: the two clean-room git hooks scan `git ls-files`. npm publishes a
# different set - `files` in package.json is ["plugin/dist","public"], and both of those
# are gitignored build output. So a comment in a source file reaches npm through the
# compiled bundle without ever passing a gate. That is not hypothetical: 0.1.0 shipped
# a non-English comment inside public/assets/, and it is still on the registry. npm
# unpublish stops being available after 72 hours, so this gate runs before the upload.
#
# The pattern list is NOT in this file. It is read from whatever CLEANROOM_GUARD points at,
# because the patterns are themselves the private terms being kept out of the repository,
# and a copy of them here would publish the very list. The scanner is tracked, the list is
# not: locally it comes from the machine's hook, and in CI the release workflow writes it
# from a repository secret. Neither path lets it reach the package - `files` in
# package.json ships plugin/dist and public, and nothing else.
set -uo pipefail

GUARD="${CLEANROOM_GUARD:-$HOME/.claude/hooks/clean-room-guard.sh}"
red()  { printf '\033[31m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }

# A gate that cannot run blocks. A scanner that silently skips is worse than no scanner,
# because the checklist then claims a check that never happened.
if [ ! -r "$GUARD" ]; then
  red "clean-room scan cannot run: pattern source not readable at $GUARD"
  echo "Set CLEANROOM_GUARD to the guard script, or restore it. Refusing to publish."
  exit 1
fi

FORBIDDEN=$(grep -m1 '^FORBIDDEN=' "$GUARD" | sed "s/^FORBIDDEN='//; s/'\$//")
if [ -z "$FORBIDDEN" ]; then
  red "clean-room scan cannot run: no pattern list found inside $GUARD"
  exit 1
fi

# The set npm would actually upload. `npm pack --dry-run` prints it to stderr as notice
# lines; the size column is stripped to leave bare paths.
files=$(npm pack --dry-run 2>&1 | sed -n 's/^npm notice *[0-9.]*[kMG]*B *//p' | grep -v '^$')
if [ -z "$files" ]; then
  red "clean-room scan cannot run: could not read the packed file list"
  exit 1
fi
count=$(printf '%s\n' "$files" | wc -l | tr -d ' ')

# The two character classes this scanner rejects are built from their UTF-8 bytes rather
# than typed out. This file is tracked in the public repository it guards, and a scanner
# that carries the characters it forbids fails its own gate on the way in.
NON_ENGLISH=$(printf '\xc4\xb1\xc5\x9f\xc4\x9f\xc3\xa7\xc3\xb6\xc3\xbc\xc4\xb0\xc5\x9e\xc4\x9e\xc3\x87\xc3\x96\xc3\x9c')
EM_DASH=$(printf '\xe2\x80\x94')

# Third-party bundles that legitimately carry characters the patterns look for. Kept
# deliberately narrow - a whole directory would hide our own output, which lands here too.
# style-*.js: MapLibre ships a vertical-writing character map whose keys include the
# long dash. It is data, not prose.
is_vendor_exempt() {
  case "$1" in
    public/assets/style-*.js) return 0 ;;
    *) return 1 ;;
  esac
}

violations=0
exempt=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  # -I skips binaries: a tracked .gz fixture matches multibyte patterns by accident.
  hit=$(grep -InE "$FORBIDDEN" "$f" 2>/dev/null | head -1)
  [ -z "$hit" ] && hit=$(grep -InE "[$NON_ENGLISH]" "$f" 2>/dev/null | head -1)
  [ -z "$hit" ] && hit=$(grep -InF "$EM_DASH" "$f" 2>/dev/null | head -1)
  [ -z "$hit" ] && continue
  if is_vendor_exempt "$f"; then
    exempt=$((exempt + 1))
    continue
  fi
  violations=$((violations + 1))
  printf '  %s:%s\n' "$f" "$(printf '%s' "$hit" | cut -c1-100)"
done <<EOF
$files
EOF

if [ "$violations" -gt 0 ]; then
  echo
  red "clean-room scan FAILED: $violations of $count published files carry forbidden content."
  echo "Everything that reaches npm must be English, professional, and free of personal,"
  echo "vessel, private-repo or AI-signature traces. Fix the SOURCE, rebuild, scan again."
  echo "Note: dist is build output - editing dist alone is undone by the next build."
  exit 1
fi

green "clean-room scan passed: $count published files clean ($exempt vendor exemption(s))."
exit 0
