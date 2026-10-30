# agent-recall

Plugin do Paseo e do OpenCode que chama de volta o agente responsável quando uma release do
`dboltbr/dbolt` fica vermelha ou é barrada antes da produção.

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
  No Paseo o prompt entra com `--behavior steer`: agente ocupado recebe o chamado dentro do turno,
  sem perder o que fazia. Prompt recusado → sessão filha no diretório da original (OpenCode; a API de plugin não tem
  fork) ou agente novo no workspace (Paseo). Se tudo falha, grava
  `recall` (`failedAt`, motivo) na nota.
- Trava `mkdir` atômica por incidente e sessão em `~/.local/state/agent-recall/`: nenhum chamado
  duplo. Na partida trata só incidentes das últimas 8 h.
- Release que falha antes da tag (verificação, build, publicação) não tem nota: o status das
  releases (o mesmo da tela Releases) diz quem fez o push. A sessão do push, se for deste harness e
  host, recebe uma vez por release
  `Release barrada release-<n>: carregue a skill dbolt-release-incident. Papel: blocked. … Release: <json>`
  (número, URL, SHA, job que falhou, sessões da faixa). Falhas das últimas 8 h; release posterior
  com tag encerra o chamado. Ninguém recebeu → só o log (não há nota).
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
  Terminado, recolhe numa linha (falha em vermelho, reversão em amarelo) que abre o card ao
  tocar. Cancelados e sem publicação seguidos do mesmo agente viram uma linha só no card mais
  novo ("4 lançamentos cancelados #246–#249"); os cards mais velhos da sequência somem.
- **Tela Releases** (rodapé, popovers, Command Center "Abrir Releases"): run em andamento com as
  faixas das imagens, fila de runners, reversões do vigia e tabela de vereditos.

Não há push do daemon para o app: o cliente lê o snapshot em cache do daemon pelas RPCs
`release.snapshot` / `release.refresh` (`shared/rpc.ts`) a cada 15 s com run em andamento e 60 s
parado. O GitHub só é chamado pelo daemon.

## Instalação

O jeito normal é `bash scripts/agent-recall.sh install` no repositório dbolt. Na mão:

```bash
# Paseo (com "pluginsEnabled": true no config.json do Paseo)
paseo plugin add git:dboltbr/agent-recall

# OpenCode (carrega quando o servidor reinicia)
opencode plugin add github:dboltbr/agent-recall
```

Conferir: `bash scripts/agent-recall.sh check` no dbolt, `paseo plugin logs agent-recall`, ou
`cat ~/.local/state/agent-recall/*.alive`.

## Autoatualização

Na partida, uma vez por processo, em segundo plano e com prazo de 60 s, o plugin pede ao próprio
harness a revisão mais nova (`core/self-update.ts`). Falha só vai para o log.

- **OpenCode**: `opencode plugin update <spec>`, com o spec lido do `package.json` da instalação
  em `…/opencode/npm/…/node_modules/agent-recall/`. O OpenCode só confere atualização ao reiniciar
  e não instala; a revisão nova carrega no reinício seguinte. Arquivo copiado, caminho local e
  spec fixado num commit são ignorados.
- **Paseo**: `paseo plugin update agent-recall --check --json`; só numa instalação `git` com
  revisão nova aplica `--yes`, e o Paseo recarrega o plugin na hora. Instalação `directory`
  (checkout de dev) é ignorada. O commit tentado fica em `~/.local/state/agent-recall/paseo.update`
  e não é reaplicado em 30 min, então um Paseo que siga propondo a mesma revisão não entra em laço.

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
npm run bundle       # server/core/ e shared/ (cópias de core/ para o Paseo) + dist/agent-recall.js
```

`server/core/`, as cópias em `shared/` e `dist/agent-recall.js` são gerados e vão no commit: o Paseo e
o OpenCode instalam direto do git (`main`/`exports` do `package.json` apontam para o bundle). O script
se chama `bundle`, não `build`: o npm do OpenCode roda `build` ao preparar dependência git e falha.

Copyright DBolt. All rights reserved.
