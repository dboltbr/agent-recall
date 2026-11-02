# Agent Recall

Chama de volta a sessão dona de uma release do `dboltbr/dbolt` que fica vermelha (com o
desfecho do rollback do vigia e o congelamento da `main`), avisa as outras sessões da faixa sem
pedir ação, e chama a sessão do push quando a release é barrada antes da produção. O mesmo repositório traz
os plugins do OpenCode e do Claude Code (`claude/`, marketplace `agent-recall`). Lê as notas `refs/notes/release-watch` a cada 30 s e grava o heartbeat
`~/.local/state/agent-recall/paseo.alive`. Configuração em `~/.config/agent-recall/config.json`.

Mostra o status das releases no Paseo: pílula no composer do agente que fez o push, linha no
rodapé da sidebar, card na timeline e a tela Releases (Command Center "Abrir Releases").

Limites conhecidos (chamado perdido quando o poller morre no meio, porta da trava tomada, troca
de versão): README, seção "Limites conhecidos".
