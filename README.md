# agent-recall

Plugin do Paseo e do OpenCode que chama de volta o agente responsável quando uma release do
`dboltbr/dbolt` fica vermelha.

## O que faz

- A cada 30 s consulta a ref `refs/notes/release-watch` do `dboltbr/dbolt` com `If-None-Match` e o
  token do `gh` do host. Resposta 304 não faz nada.
- Quando a ref muda, busca as notas (uma por tag `release-<n>`) e lê as sessões
  `Agent-Session: paseo/<serverId>/<agentId>` | `opencode/<instance>/<ses_…>` da faixa.
- Só chama sessões do próprio harness e host:
  - `red` com uma sessão → essa sessão investiga;
  - `red` com várias → só o host com `incidentHost: true` abre uma sessão nova de investigação;
  - `reverted` | `fix-pending` → a sessão original do commit culpado recebe a correção;
  - `fix-pending` há 30 min sem `fix.readyAt` → lembra o owner.
- O chamado é o prompt
  `Incidente release-<n>: carregue a skill dbolt-release-incident. Papel: <investigate|fix>. Nota: <json>`.
  Prompt recusado → sessão filha no diretório da original (OpenCode; a API de plugin não tem
  fork) ou agente novo no workspace (Paseo). Se tudo falha, grava
  `recall` (`failedAt`, motivo) na nota.
- Trava `mkdir` atômica por incidente e sessão em `~/.local/state/agent-recall/`: nenhum chamado
  duplo. Na partida trata só incidentes das últimas 8 h.
- Heartbeat a cada consulta em `~/.local/state/agent-recall/<paseo|opencode>.alive`:
  `{ "pid", "polledAt", "sha" }`. O hook de commit do dbolt exige esse arquivo.
- No OpenCode, um poller por host (trava `~/.local/state/agent-recall/opencode.poller`) que vive o
  processo inteiro: o despejo da localização ociosa não o para (o contexto descartado segue
  chamando sessões). O heartbeat só é gravado depois que o contexto respondeu. Arquivo do plugin
  trocado com outro SHA assume o poller no mesmo processo.

## Status de release no Paseo

O daemon lê os runs do workflow `release` do `dboltbr/dbolt` (job, runner, fila) com o token do
`gh`, a cada ~30 s com run em andamento e ~5 min parado, com ETag e prazo de 25 s por chamada.
O modelo fica em `core/release-status.ts`, a cópia em pt-BR em `core/release-copy.ts`.

- **Pílula do composer** (`release-172 · imagens 3/9`): só nos agentes com commit na release em
  andamento ou na última. O popover mostra as etapas com duração, as imagens, a fila de runners e
  os links ver run / ver commit / abrir Releases.
- **Rodapé da sidebar**: a release em andamento, ou o último veredito por 2 h, com a barra de cinco
  etapas. Sem nada recente, a linha "Releases" abre a tela.
- **Card na timeline** do agente que fez o push (`core/release-cards.ts`): reanexado com o mesmo
  id enquanto o run anda; variantes de falha (job + ver log) e de reversão (sinais do vigia).
- **Tela Releases** (rodapé, popovers, Command Center "Abrir Releases"): run em andamento com as
  faixas das imagens, fila de runners, reversões do vigia e tabela de vereditos.

Não há push do daemon para o app: o cliente lê o snapshot em cache do daemon pelas RPCs
`release.snapshot` / `release.refresh` (`shared/rpc.ts`) a cada 15 s com run em andamento e 60 s
parado. O GitHub só é chamado pelo daemon.

## Instalação

O jeito normal é `bash scripts/agent-recall.sh install` no repositório dbolt. Na mão:

```bash
# Paseo
paseo plugin install git:dboltbr/agent-recall --ref main
paseo reload            # com "pluginsEnabled": true no config.json do Paseo

# OpenCode (carrega quando o servidor reinicia)
mkdir -p ~/.config/opencode/plugins
gh api -H 'Accept: application/vnd.github.raw' \
  repos/dboltbr/agent-recall/contents/dist/agent-recall.js?ref=main \
  > ~/.config/opencode/plugins/agent-recall.js
```

Conferir: `bash scripts/agent-recall.sh check` no dbolt, `paseo plugin logs agent-recall`, ou
`cat ~/.local/state/agent-recall/*.alive`.

## Configuração do host

`~/.config/agent-recall/config.json`:

```json
{
  "instance": "archdev",
  "incidentHost": true,
  "repository": "dboltbr/dbolt",
  "notesRef": "refs/notes/release-watch"
}
```

- `instance`: nome do host nos trailers `opencode/<instance>/…` (o Paseo usa o `server-id`).
- `incidentHost`: só um host do time fica `true`; é ele que abre a sessão de investigação.
- `notesRef`: `refs/notes/release-watch-drill` no ensaio.

## Desenvolvimento

```bash
npm install
npm test             # node:test, relógio fixo
npm run typecheck
npm run build        # server/core/ e shared/ (cópias de core/ para o Paseo) + dist/agent-recall.js
```

`server/core/`, as cópias em `shared/` e `dist/agent-recall.js` são gerados e vão no commit: o Paseo instala direto do git
e o OpenCode copia o arquivo pronto.

Copyright DBolt. All rights reserved.
