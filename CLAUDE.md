# PEDON

@AGENTS.md

@AGENTS.local.md

`AGENTS.md` above is the entry point, and it is the same file every tool reads —
Codex and most agents load it by name, Claude Code gets it through this import.
Keep instructions THERE, not here, or the two halves of the project drift apart
and only one tool sees the correction. `AGENTS.local.md` is a checkout's own working
notes, untracked; `AGENTS.md` tells every other tool to read it when it exists.
