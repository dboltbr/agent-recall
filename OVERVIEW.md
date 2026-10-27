# Agent Recall

Chama de volta a sessão do agente responsável quando uma release do `dboltbr/dbolt` fica
vermelha. Lê as notas `refs/notes/release-watch` a cada 30 s e grava o heartbeat
`~/.local/state/agent-recall/paseo.alive`. Configuração em `~/.config/agent-recall/config.json`.
