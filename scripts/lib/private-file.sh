write_private_dump() {
  local path="$1"
  local dir
  dir="$(dirname "$path")"
  mkdir -p "$dir"
  chmod 700 "$dir"
  (umask 077; cat > "$path")
  chmod 600 "$path"
}
