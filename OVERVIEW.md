# Agent Recall

Chama de volta a sessão do agente responsável quando uma release do `dboltbr/dbolt` fica
vermelha, e a sessão do push quando a release é barrada antes da produção. Lê as notas `refs/notes/release-watch` a cada 30 s e grava o heartbeat
`~/.local/state/agent-recall/paseo.alive`. Configuração em `~/.config/agent-recall/config.json`.

Mostra o status das releases no Paseo: pílula no composer do agente que fez o push, linha no
rodapé da sidebar, card na timeline e a tela Releases (Command Center "Abrir Releases").
