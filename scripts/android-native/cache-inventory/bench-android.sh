#!/system/bin/sh
set -eu
export LD_LIBRARY_PATH="$PWD/files/usr/lib"
fixture=$(mktemp -d "$PWD/files/cache-bench.XXXXXXXX")
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/tree" "$fixture/elsewhere"
printf 'must not be counted' > "$fixture/elsewhere/outside"
for dir in $(seq 1 40); do
  mkdir "$fixture/tree/$dir"
  for file in $(seq 1 100); do
    printf '0123456789abcdef' > "$fixture/tree/$dir/$file"
  done
done
ln -s "$fixture/elsewhere" "$fixture/tree/link"
ln -s "$fixture/missing" "$fixture/tree/dangling"
run_node() {
  check /system/bin/toybox time -v files/usr/bin/node files/dsh-cache-inventory.cjs "$fixture/tree"
}
run_rust() {
  check /system/bin/toybox time -v files/dsh-cache-inventory "$fixture/tree"
}
check() {
  result=$("$@" 2>&1) || { printf '%s\n' "$result" >&2; return 1; }
  printf '%s\n' "$result"
  printf '%s\n' "$result" | grep -qx 'bytes=64000 files=4002'
}
for trial in 1 2 3 4 5; do
  echo "trial=$trial variant=node"; run_node
  echo "trial=$trial variant=rust"; run_rust
  echo "trial=$trial variant=rust"; run_rust
  echo "trial=$trial variant=node"; run_node
done
if files/dsh-cache-inventory "$fixture/missing"; then
  echo 'negative control failed' >&2
  exit 1
fi
