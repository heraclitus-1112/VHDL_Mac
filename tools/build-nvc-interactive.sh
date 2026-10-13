#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds the GPL-3.0-or-later upstream NVC release outside the extension.
# "official" adds upstream Tcl support only. "livewave" also applies the
# experimental local native-wave/simstatus patch; it is not an upstream release.
# No NVC binaries are bundled with the extension. Redistributors of a compiled
# patched NVC must also provide corresponding source and comply with upstream
# COPYING, which remains in the retained source directory printed below.
set -euo pipefail

mode=livewave
prefix=
build_parent="${TMPDIR:-/tmp}"
install_deps=0
usage() {
  cat <<'EOF'
Usage: build-nvc-interactive.sh [official|livewave] [options]
  --prefix PATH        Separate install prefix; never overwrites brew NVC
  --build-dir PATH     Parent directory for retained source and build logs
  --install-deps       Install Homebrew build dependencies (no update/cleanup)
  --help               Show this help

Default: livewave, ~/.local/share/vhdl-mac/nvc-interactive-livewave.
Official mode: upstream NVC 1.23.0 with --enable-tcl, without local wave API.
Livewave mode: experimental patch adds wave <file>, wave -flush, simstatus.
VCD snapshots are available at initialization and after each run, including #0.
Each run retains simulator state. SIGINT exits NVC; pause at run boundaries.
The shell's upstream restart command is unsupported; restart needs a new process.
EOF/exit finalizes the waveform. Upstream and the patch use GPL-3.0-or-later.
EOF
}
while (($#)); do
  case "$1" in
    official|livewave) mode="$1"; shift ;;
    --prefix) prefix="${2:?Missing --prefix value}"; shift 2 ;;
    --build-dir) build_parent="${2:?Missing --build-dir value}"; shift 2 ;;
    --install-deps) install_deps=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ "$(uname -s)" != Darwin ]]; then
  printf 'This build script is for macOS with Homebrew.\n' >&2
  exit 2
fi
if [[ -z "$prefix" ]]; then
  prefix="$HOME/.local/share/vhdl-mac/nvc-interactive"
  [[ "$mode" != livewave ]] || prefix="${prefix}-livewave"
fi
case "$prefix" in
  /*) ;;
  *) printf 'Install prefix must be absolute.\n' >&2; exit 2 ;;
esac
brew_bin="$(command -v brew || true)"
[[ -n "$brew_bin" ]] || brew_bin=/opt/homebrew/bin/brew
[[ -x "$brew_bin" ]] || { printf 'Homebrew is required.\n' >&2; exit 2; }
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
if ((install_deps)); then
  "$brew_bin" install llvm tcl-tk@8 readline zstd pkgconf check
fi
brew_prefix="$("$brew_bin" --prefix)"
if [[ "$prefix" == "$brew_prefix" || "$prefix" == "$brew_prefix/opt/nvc" ||
      "$prefix" == "$brew_prefix/Cellar/nvc/"* ]]; then
  printf 'Refusing to overwrite Homebrew NVC.\n' >&2
  exit 2
fi
llvm_prefix="$("$brew_bin" --prefix llvm)"
tcl_prefix="$("$brew_bin" --prefix tcl-tk@8)"
readline_prefix="$("$brew_bin" --prefix readline)"
zstd_prefix="$("$brew_bin" --prefix zstd)"
pkgconf_prefix="$("$brew_bin" --prefix pkgconf)"
for task_path in "$llvm_prefix/bin/llvm-config" "$tcl_prefix/lib/pkgconfig/tcl.pc" \
                 "$readline_prefix/include/readline/readline.h" "$pkgconf_prefix/bin/pkg-config"; do
  [[ -e "$task_path" ]] || { printf 'Missing dependency: %s (use --install-deps)\n' "$task_path" >&2; exit 2; }
done
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$build_parent"
run_dir="$(mktemp -d "$build_parent/vhdl-mac-nvc.XXXXXX")"
archive="$run_dir/nvc-1.23.0.tar.gz"
curl --fail --location --retry 3 \
  https://github.com/nickg/nvc/releases/download/r1.23.0/nvc-1.23.0.tar.gz \
  --output "$archive"
printf '%s  %s\n' 10dab7ea016d8a2f7c4ea74a438b6c999423007aa69c0568fedb59564440b3e2 "$archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$run_dir"
source_dir="$run_dir/nvc-1.23.0"
if [[ "$mode" == livewave ]]; then
  patch --batch --forward -d "$source_dir" -p1 < "$script_dir/nvc-1.23.0-livewave.patch"
fi
mkdir "$run_dir/build"
export PATH="$pkgconf_prefix/bin:$brew_prefix/bin:$PATH"
export PKG_CONFIG_PATH="$tcl_prefix/lib/pkgconfig:$readline_prefix/lib/pkgconfig:$zstd_prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export CPPFLAGS="-I$readline_prefix/include${CPPFLAGS:+ $CPPFLAGS}"
export LDFLAGS="-L$readline_prefix/lib${LDFLAGS:+ $LDFLAGS}"
jobs="$(sysctl -n hw.ncpu)"
cd "$run_dir/build"
"$source_dir/configure" --prefix="$prefix" --with-llvm="$llvm_prefix/bin/llvm-config" --enable-tcl > configure.log 2>&1
make -j"$jobs" 'SHLIB_LDFLAGS=-shared -undefined dynamic_lookup -Wl,-no_fixup_chains' > build.log 2>&1
make 'SHLIB_LDFLAGS=-shared -undefined dynamic_lookup -Wl,-no_fixup_chains' install > install.log 2>&1

mkdir "$run_dir/smoke"
cd "$run_dir/smoke"
cat > smoke.vhd <<'EOF'
library ieee;
use ieee.std_logic_1164.all;
entity smoke is end;
architecture test of smoke is
  signal clk : std_logic := '0';
  signal enable : std_logic := '0';
  signal count : integer := 0;
begin
  clk <= not clk after 5 ns;
  process begin enable <= '0'; wait for 10 ns; end process;
  process(clk) begin
    if rising_edge(clk) and enable = '1' then count <= count + 1; end if;
  end process;
end;
EOF
cat > smoke.tcl <<'EOF'
if {[llength [info commands wave]]} {wave smoke.vcd}
run 6 ns
force /enable '1'
run 20 ns
if {[examine /count] != 2} {error "force/continue smoke test failed"}
noforce /enable
run 10 ns
if {[examine /count] != 2 || $now != 35000000} {error "release/continue smoke test failed"}
if {[llength [info commands wave]]} {
  wave -flush
  set f [open smoke.vcd r]; set vcd [read $f]; close $f
  if {[string first "#35000000" $vcd] < 0} {error "native live VCD smoke test failed"}
  if {[dict get [simstatus] stopped]} {error "unexpected stopped state"}
}
puts "PASS retained state, force, release, and applicable native waveform"
EOF
"$prefix/bin/nvc" -a smoke.vhd -e smoke --do smoke.tcl
if [[ "$mode" == livewave ]]; then
  cat > zero.vhd <<'EOF'
library ieee;
use ieee.std_logic_1164.all;
entity zero is end;
architecture test of zero is
  signal a : std_logic := '0';
  signal y : std_logic;
begin
  y <= not a;
end;
EOF
  cat > zero.tcl <<'EOF'
wave zero.vcd
run 1 ns
if {$now != 0 || [examine /y] ne "'1'"} {error "zero-time initialization failed"}
force /a '1'
run 1 ns
if {$now != 0 || [examine /y] ne "'0'"} {error "zero-time force failed"}
set f [open zero.vcd r]; set vcd [read $f]; close $f
if {![regexp {\$var \S+ \d+ (\S+) y \$end} $vcd -> yid]} {error "zero-time VCD hierarchy missing"}
set latest ""
foreach line [split $vcd "\n"] {
  if {[string range $line 1 end] eq $yid} {set latest [string index $line 0]}
}
if {$latest ne "0" || [string range $vcd end-4 end] ne "\$end\n"} {error "zero-time live VCD incomplete"}
puts "PASS zero-time live VCD and combinational force without advancing time"
EOF
  "$prefix/bin/nvc" -a zero.vhd -e zero --do zero.tcl
fi
"$prefix/bin/nvc" --version
printf 'Mode: %s\nExecutable: %s/bin/nvc\nGPL source and build logs: %s\n' "$mode" "$prefix" "$run_dir"
