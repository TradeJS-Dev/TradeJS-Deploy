#!/usr/bin/env sh

set -eu

swap_file="${SWAP_FILE:-/swapfile}"
swap_size="${SWAP_SIZE:-4G}"
swappiness="${SWAPPINESS:-10}"

if [ ! -f "$swap_file" ]; then
  fallocate -l "$swap_size" "$swap_file"
  chmod 600 "$swap_file"
  mkswap "$swap_file" >/dev/null
elif [ "$(blkid -s TYPE -o value "$swap_file" 2>/dev/null || true)" != "swap" ]; then
  chmod 600 "$swap_file"
  mkswap "$swap_file" >/dev/null
fi

if ! swapon --show=NAME --noheadings | grep -Fxq "$swap_file"; then
  swapon "$swap_file"
fi

if ! grep -qE "^${swap_file}[[:space:]]" /etc/fstab; then
  printf '%s none swap sw 0 0\n' "$swap_file" >> /etc/fstab
fi

sysctl -w "vm.swappiness=$swappiness" >/dev/null
