# dashboard.bashrc: rc file for the dashboard web terminal only.
# term_login.py execs `bash --rcfile <this file> -i` after a successful login. The owner's SSH sessions
# and ~/.bashrc are untouched (this file only reads them).
#
# Must parse under bash 3.2 and run under bash 5.2. Keep it ASCII except the prompt glyphs, which must
# stay inside the web font subset (UNICODES in scripts/make-font-subset.sh; a test checks this).
#
# With DASH_RC_FUNCS_ONLY set, only the functions are defined (used by the tests).

# __dash_short_cwd [path]: p10k-style short path. $HOME becomes ~; with more than 3 segments, every
# segment but the last 2 is cut to its first char (first two if it starts with a dot).
__dash_short_cwd() {
  local p="${1-$PWD}" pre="" rest out="" i n seg
  if [ -n "$HOME" ] && [ "$HOME" != "/" ]; then
    case "$p" in
      "$HOME") pre="~"; p="" ;;
      "$HOME"/*) pre="~"; p="${p#"$HOME"}" ;;
    esac
  fi
  rest="${p#/}"
  if [ -z "$rest" ]; then
    if [ -n "$pre" ]; then printf '%s\n' "$pre"; else printf '/\n'; fi
    return 0
  fi
  local -a s
  n=0
  # split on / by hand (read -a would stop at a newline in a directory name)
  while :; do
    case "$rest" in
      */*) s[n]=${rest%%/*}; rest=${rest#*/} ;;
      *) s[n]=$rest; n=$((n + 1)); break ;;
    esac
    n=$((n + 1))
  done
  i=0
  while [ "$i" -lt "$n" ]; do
    seg=${s[$i]}
    if [ "$i" -lt $((n - 1)) ]; then
      case "$seg" in
        .*) seg=${seg:0:3} ;;
        *) seg=${seg:0:2} ;;
      esac
    fi
    out="$out/$seg"
    i=$((i + 1))
  done
  printf '%s\n' "$pre$out"
}

# __dash_git: inside a work tree, print the branch, plus " *" when tracked files changed, or " ?" when
# the dirty check was skipped as unsafe. Prints nothing outside a repo. Untracked files are ignored (-uno).
#
# A repo's own config can make `git status` run commands: core.fsmonitor, and clean filters (filter.*),
# which status runs while re-hashing a file whose stat changed. Repos written by containers running as
# the owner's uid pass git's safe.directory check, so merely cd-ing into a downloaded tree must not run
# them. core.fsmonitor is forced off, hooks are pointed at /dev/null, --no-optional-locks keeps status
# from writing the index, submodules are not entered, and if any filter is configured outside the
# owner's global/system config the dirty check is skipped. symbolic-ref and config run no such commands.
# In a partial clone, a missing object makes git lazy-fetch it, running the repo's core.sshCommand or
# remote.<x>.uploadpack: GIT_ALLOW_PROTOCOL=none (beats repo protocol.*.allow) and GIT_NO_LAZY_FETCH=1
# stop that. Each call is cut off after 2 s when coreutils timeout exists; a cut-off status shows " ?".

# __dash_g ARGS...: git with all of the guards above.
__dash_g() {
  if command -v timeout >/dev/null 2>&1; then
    GIT_ALLOW_PROTOCOL=none GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 \
      timeout 2 git -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-optional-locks "$@"
  else
    GIT_ALLOW_PROTOCOL=none GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 \
      git -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-optional-locks "$@"
  fi
}

__dash_git() {
  local b rc cfg scope rest safe out
  b=$(__dash_g symbolic-ref --short -q HEAD 2>/dev/null)
  rc=$?
  if [ "$rc" -eq 1 ]; then
    b=$(__dash_g rev-parse --short HEAD 2>/dev/null) || b=HEAD
  elif [ "$rc" -ne 0 ]; then
    return 1
  fi
  [ -n "$b" ] || return 1

  safe=0
  cfg=$(__dash_g config --show-scope --get-regexp '^filter\.' 2>/dev/null)
  rc=$?
  if [ "$rc" -eq 1 ]; then
    safe=1
  elif [ "$rc" -eq 0 ]; then
    safe=1
    while read -r scope rest; do
      case "$scope" in
        global|system) ;;
        *) safe=0 ;;
      esac
    done <<EOF
$cfg
EOF
  fi
  if [ "$safe" -ne 1 ]; then
    printf '%s ?\n' "$b"
    return 0
  fi

  out=$(__dash_g status --porcelain -uno --ignore-submodules=all 2>/dev/null) || { printf '%s ?\n' "$b"; return 0; }
  if [ -n "$out" ]; then
    printf '%s *\n' "$b"
  else
    printf '%s\n' "$b"
  fi
}

# Text that goes into PS1 literally (cwd, branch). Double every backslash so it can't form a prompt
# escape, and replace C0 controls, DEL and C1 controls (UTF-8 C2 80..C2 9F) with ?, as ls does, so a
# directory name can't move the cursor, retitle the window or clear the screen. Works byte by byte in
# the C locale so it behaves the same whatever LANG is; other UTF-8 passes through unchanged.
# promptvars is off in dashboard sessions, so $(...) and `...` in a path or branch are never run.
__dash_lit() {
  local LC_ALL=C
  local s=$1 out="" c n
  while [ -n "$s" ]; do
    c=${s:0:1}
    s=${s:1}
    case "$c" in
      '\') out="$out\\\\" ;;
      [$'\001'-$'\037'$'\177']) out="$out?" ;;
      $'\302')
        n=${s:0:1}
        case "$n" in
          [$'\200'-$'\237']) out="$out?"; s=${s:1} ;;
          *) out="$out$c" ;;
        esac
        ;;
      *) out="$out$c" ;;
    esac
  done
  printf '%s' "$out"
}

# __dash_build_ps1 EXIT SECS: print a one-line prompt in the style of a plain zsh prompt:
#   ~/Pr/home-server-dashboard main >                                            09:25:18 PM
# Parent folders dim lavender, the current folder bold blue, the branch green (yellow with " *" when
# tracked files changed), ">" green or red after a failed command. The time (and the last command's
# duration when it took over 2 s) is right-aligned in dim teal: it is printed first at column
# COLUMNS-len+1, then the prompt escape \r (not a raw CR byte) returns to column 1, all inside \[ \] so bash counts none of it toward the
# width. It is left out when it would not fit beside the left part. Every escape is wrapped in \[ \].
__dash_build_ps1() {
  local code=${1:-0} secs=${2:-0} cwd parent last g gcol ccol t right vis cols pre="" ps
  case "$code" in ''|*[!0-9]*) code=1 ;; esac
  case "$secs" in ''|*[!0-9]*) secs=0 ;; esac

  cwd=$(__dash_short_cwd "$PWD")
  case "$cwd" in
    /) parent=""; last="/" ;;
    */*) parent="${cwd%/*}/"; last=${cwd##*/} ;;
    *) parent=""; last=$cwd ;;
  esac
  ps="\[\e[38;5;103m\]$(__dash_lit "$parent")\[\e[1;38;5;39m\]$(__dash_lit "$last")\[\e[0m\]"
  vis=$cwd

  if g=$(__dash_git) && [ -n "$g" ]; then
    case "$g" in
      *' *'|*' ?') gcol=178 ;;
      *) gcol=76 ;;
    esac
    ps="$ps \[\e[38;5;${gcol}m\]$(__dash_lit "$g")\[\e[0m\]"
    vis="$vis $g"
  fi

  if [ "$code" -eq 0 ]; then ccol=76; else ccol=196; fi
  vis="$vis > "

  printf -v t '%(%I:%M:%S %p)T' -1 2>/dev/null || t=$(date +'%I:%M:%S %p')
  right=$t
  if [ "$secs" -gt 2 ]; then right="${secs}s $t"; fi
  cols=${COLUMNS:-80}
  case "$cols" in ''|*[!0-9]*) cols=80 ;; esac
  if [ $(( ${#vis} + ${#right} + 2 )) -le "$cols" ]; then
    pre="\[\e[$((cols - ${#right} + 1))G\e[38;5;66m$right\e[0m\r\]"
  fi

  printf '%s' "$pre$ps \[\e[38;5;${ccol}m\]>\[\e[0m\] "
}

# Runs first in PROMPT_COMMAND: capture $?, time the last command, rebuild PS1.
__dash_prompt() {
  local e=$? s=0
  if [ -n "$__dash_t0" ]; then
    s=$((SECONDS - __dash_t0))
  fi
  shopt -u promptvars
  PS1=$(__dash_build_ps1 "$e" "$s")
  unset __dash_t0
}

if [ -z "${DASH_RC_FUNCS_ONLY-}" ]; then
  # --rcfile and -l don't combine, so do what a login shell would, then what ~/.bashrc would.
  [ -r /etc/profile ] && . /etc/profile
  __dash_prof=""
  for __dash_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$__dash_f" ]; then
      __dash_prof=$__dash_f
      . "$__dash_f"
      break
    fi
  done
  if [ -r /etc/bash.bashrc ] && ! grep -qs 'bash.bashrc' /etc/profile; then
    . /etc/bash.bashrc
  fi
  if [ -r "$HOME/.bashrc" ] && ! { [ -n "$__dash_prof" ] && grep -qs '\.bashrc' "$__dash_prof"; }; then
    . "$HOME/.bashrc"
  fi
  unset __dash_f __dash_prof

  # PS1 is rebuilt as plain text each prompt, so prompt expansion of $(...) is not needed (and is unsafe
  # for directory and branch names).
  shopt -u promptvars
  # Start the timer at the first command after a prompt. The trap always returns 0 (with extdebug, a
  # non-zero DEBUG trap would skip the command). If the owner's rc already has a DEBUG trap (e.g.
  # bash-preexec), keep theirs and go without the duration segment rather than replace or wrap it.
  if [ -z "$(trap -p DEBUG)" ]; then
    trap '[ -n "$__dash_t0" ] || __dash_t0=$SECONDS' DEBUG
  fi
  # __dash_prompt goes first to see the command's $?; the timer is cleared again after any other
  # prompt commands, so their run doesn't start the next timer. Newlines, not ';', join the parts, so
  # an owner value ending in '; ' or a '# comment' can't break the whole PROMPT_COMMAND.
  __dash_nl=$'\n'
  PROMPT_COMMAND="__dash_prompt${PROMPT_COMMAND:+$__dash_nl$PROMPT_COMMAND${__dash_nl}unset __dash_t0}"
  unset __dash_nl
fi
