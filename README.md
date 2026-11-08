# agent-recall

Plugin do Paseo, do OpenCode e do Claude Code que chama de volta o agente responsável quando uma
release do `dboltbr/dbolt` fica vermelha ou é barrada antes da produção.

## Fonte factory (IA-6)

Para migrar este host, adicione `factoryApiUrl` à configuração local:

```json
{
  "instance": "meu-host",
  "repository": "dboltbr/dbolt",
  "factoryApiUrl": "https://<factory>/releases/recall"
}
```

Forneça `FACTORY_RECALL_TOKEN` ao processo do plugin; `factoryToken` no arquivo local
protegido também é aceito. Este branch não instala, recarrega ou altera configuração do host.
A API exige bearer, consulta a cada 30 s com ETag e deadline de 10 s incluindo o corpo.
Falha de autenticação/rede/schema não consulta git notes como fallback. O callback mantém a
trava por release/sessão/papel, o dono aguardando desfecho de rollback por até 10 min e os
notificados no próprio host. Prompts usam a faixa, evidências, rollback e `frozen` da API;
dry-run não afirma que a main está congelada. Falhas totais de entrega ficam no log local.

A configuração é o passo de troca: hosts ainda sem `factoryApiUrl` continuam no modo atual
abaixo. No modo factory a ref de releases barradas continua sendo consultada como fonte independente;
a migração desse fluxo é coordenada com IA-5. Falha na API de publicados não desliga as barradas. A tela OpenChamber tem um loader próprio ainda não migrado. A API
substitui a fonte de incidentes dos callbacks Paseo/OpenCode/Claude Code, sem mudar as UIs.

## O que faz

- A cada 30 s consulta as refs `refs/notes/release-watch` (incidentes) e `refs/notes/release-blocked`
  (releases barradas) do `dboltbr/dbolt` com `If-None-Match` e o token do `gh` do host. Resposta 304
  não faz nada; ref ausente no remoto = nenhuma nota daquele tipo.
- Quando a ref muda, busca as notas (uma por tag `release-<n>`). A nota, gravada pelo vigia, traz
  o `owner` (a `Agent-Session` do commit mais novo da faixa), os `notified` (as outras sessões da
  faixa, `paseo/<serverId>/<agentId>` | `opencode/<instance>/<ses_…>` |
  `claude/<instance>/<sessionId>`) e o `rollback` que o vigia
  fez (`reverted` no `dbolt-deploy` ou nas flags da `main`, `blocked`, `failed`, `none`, `pending`).
- Só chama sessões do próprio harness e host, uma vez por sessão e papel:
  - `owner` → pedido de ação: motivo do vermelho, desfecho do rollback e congelamento da `main`
    (corrigir com `Fixes-Release` ou reverter com `Reverts-Release`). Espera o vigia gravar o
    desfecho do rollback; se ele seguir `pending`, chama aos 10 min do veredito;
  - `notified` → aviso sem pedido de ação, com o nome do dono e o aviso de que o próximo push de
    código para a `main` será recusado até a correção verde. Vai na hora;
  - nota sem `owner` não chama ninguém; nota com `resolvedBy` (correção verde) também não.
- Os chamados são os prompts
  `Incidente release-<n>: carregue a skill dbolt-release-incident. Papel: <owner|notified>. … Nota: <json>`.
  No Paseo o prompt entra com `--behavior steer`: agente ocupado recebe o chamado dentro do turno,
  sem perder o que fazia. Prompt recusado → sessão filha no diretório da original (OpenCode; a API de plugin não tem
  fork), agente novo no workspace (Paseo) ou cópia da sessão em segundo plano (Claude Code, abaixo).
  Se tudo falha, grava `recall` (`failedAt`, motivo) na nota.
- Trava `mkdir` atômica por incidente, papel e sessão em `~/.local/state/agent-recall/`: nenhum
  chamado duplo. A cada consulta revê as notas das últimas 8 h, mesmo sem a ref mudar (é assim que
  o dono de um rollback que ficou `pending` é chamado aos 10 min).
- Release barrada antes da tag (verificação, build, publicação): o job `blocked-note` do dbolt grava a
  nota em `refs/notes/release-blocked` no SHA da cabeça do run (não há tag): `state`, faixa,
  `sessions` (cada `Agent-Session` identificado com seus commits), `owner` (texto
  `<harness>/<host>/<id>`), `run` (`url`, `failedJob`), `assessment.suspects`, `fix`. Chama:
  - `red` sem owner → a sessão da faixa mais perto da cabeça fora de `expired` (commit sem trailer
    não conta): a do commit da cabeça (`range.to`), depois a ordem da nota (o CI lista pelo commit
    mais novo de cada uma); nenhuma sessão na faixa → ninguém (o run vermelho avisa o humano);
  - `fix-pending` → a sessão de cada culpado de `assessment.suspects` fora de `expired`, no host
    dela, salvo o owner;
  - `investigating`, `duplicate`, `shipped`, `unrelated`, `escalated` → ninguém.

  Sessão que é lane não é chamada: agente Paseo com `paseo.parent-agent-id` dá lugar ao pai, até a
  raiz; sessão filha do OpenCode, à raiz (`parentID`). A raiz ocupa o lugar da lane; raiz já em
  `expired` leva a lane junto e a próxima sessão é chamada.

  Todo chamado é
  `Release barrada release-<n>: carregue a skill dbolt-release-incident. Papel: blocked. Release: <json>`
  (número, URL do run, `headSha`, job que falhou, estado); a skill decide entre investigar e
  corrigir pelo estado da nota. Travas `<sessão>.blocked` e `<sessão>.blocked-fix`. Só notas com
  `updatedAt` das últimas 8 h; release com tag igual ou posterior encerra o chamado. A nota só é
  roteada com a busca barrada desta volta em dia e o histórico de releases atualizado; senão
  espera a próxima volta.
- Confirmação da release barrada, nos três harnesses: o chamado vale quando a nota passa a ter
  `owner` (`red`) ou `fix.session` (`fix-pending`) igual à sessão chamada. Sem isso em 2 min, a
  cópia de reserva (agente novo no Paseo, sessão filha no OpenCode, cópia em segundo plano no Claude
  Code). Nota que saiu do estado do chamado, ou release posterior com tag, encerra sem cópia; sem
  histórico de releases a espera segue. Cópia que falha → `recall` na nota barrada.
- Posse da release barrada (`blockedLease`, em `core/route.ts`): quem detém (`owner` em
  `investigating`, `fix.session` em `fix-pending`) mantém a posse enquanto o sinal mais novo
  (`heartbeatAt`, `updatedAt`) tem menos de 20 min. O plugin do host da detentora grava
  `heartbeatAt` a partir dos 10 min se a sessão trabalha (em turno ou ativa nos últimos 10 min:
  `paseo inspect`, `time.busy`/`time.idle`/`time.updated` do OpenCode, mtime do transcript do
  Claude Code), ou se uma sessão abaixo dela trabalha (lanes do Paseo por `paseo.parent-agent-id`,
  sessões filhas do OpenCode): o orquestrador espera ocioso enquanto as lanes corrigem. O heartbeat
  sai mesmo quando este host não lê o histórico de releases; expirar e chamar, não.
  Posse vencida, ou chamado `red`/correção não assumido em 20 min → qualquer plugin devolve a nota a
  `red`, sem `owner`, `fix` nem `heartbeatAt`, e põe a sessão em `expired` (`{session, at,
  reason}`); ela não é chamada de novo e a trava ganha a geração (`<sessão>.blocked-<n>`). Toda
  escrita é CAS (`updateNote`) e decide de novo sobre a nota que substitui; escrita tentada (feita
  ou recusada pela nota remota) deixa a cópia local velha: nada é chamado nem conferido com ela até
  a próxima consulta. Falha de chamado em nota barrada não move `updatedAt`.
- Lane chama a raiz (`resolveRoot`: pais do mesmo daemon Paseo com registro aqui, ou `parentID`
  do OpenCode; sem resposta, a própria sessão). Raiz já expirada, por ela mesma ou por outra lane
  dela em `expired`, expira a lane com `raiz <raiz> expirada`: uma chamada por raiz.
- `fix-pending` com todo culpado além da dona em `expired` e sem `fix.session`: a dona é chamada
  uma vez com o papel `fix`.
- Nota `red` com toda sessão da faixa em `expired`: o host de incidente (`incidentHost` +
  `incidentCheckout`) reivindica `incident: {by, at}` por CAS, abre um agente novo no checkout com o
  chamado `blocked` e grava `incident.session`. Sem host de incidente, ou se ninguém assumir em 20
  min (o agente expirou, ou abrir falhou), `recall` com `abandoned: true`, uma vez. Nota já
  abandonada não abre agente.
- Heartbeat a cada consulta em `~/.local/state/agent-recall/<paseo|opencode|claude>.alive`:
  `{ "pid", "polledAt", "sha" }`. O hook de commit do dbolt exige esse arquivo.
- No OpenCode, um poller por host (trava de host `opencode.poller`, ver "Travas do host") que vive o
  processo inteiro: o despejo da localização ociosa não o para (o contexto descartado segue
  chamando sessões). O heartbeat só é gravado depois que o contexto respondeu. Arquivo do plugin
  trocado com outro SHA assume o poller no mesmo processo.
## Travas do host

Os pollers do host, um por harness (`opencode.poller`, `claude.poller`), são escuta TCP em
127.0.0.1, não arquivo:
o kernel solta a porta quando o dono morre, até por `kill -9`, e `release` a solta (com prazo de
1 s) para uma recarga no mesmo processo. Nada em disco fica velho. Uma porta por trava, do hash do
diretório de estado e do nome (20000–31999, abaixo das faixas efêmeras do Linux e do macOS). O
dono escreve `agent-recall <hash do diretório> <nome> <pid>` a cada conexão e a fecha na hora.
Listen recusado → conecta e lê: resposta do dono → trava tomada; recusa (o dono acabou de morrer)
→ listen de novo; outra resposta ou silêncio → `porta <n> ocupada por outro programa: este host
não consulta` no log, uma vez, e o host fica sem essa trava. Não há segunda porta. A porta só é
sondada depois de um listen recusado: no WSL em modo espelhado conexão a porta livre fica muda em
vez de recusada.

## Claude Code

O Claude Code não tem processo de plugin: o plugin (`claude/`, marketplace `agent-recall` na raiz
deste repositório) roda um vigia dentro de cada processo do Claude Code, por hooks `asyncRewake`
(`timeout` 86400). Um hook `asyncRewake` que sai 2 acorda o modelo com o próprio stderr.

- **Um vigia por processo.** `SessionStart` (partida, resume, `/clear`, compact) e `Stop` armam
  o vigia e gravam a sessão atual em `~/.local/state/agent-recall/claude/pids/<CLAUDE_PID>`;
  `PostToolUse` só rearma (o `bin/watch.sh` sai na hora quando o processo já tem vigia vivo, sem
  subir o node). Um vigia por processo: o diretório `claude/armed/<CLAUDE_PID>` nasce já com o
  `holder` (pid do vigia) dentro, preparado ao lado e posto no lugar por `rename`, que falha sobre
  um diretório com conteúdo: nunca há trava sem dono. Outro hook que acha um `holder` vivo sai 0;
  morto (o vigia levou `kill -9`) ou ausente → o diretório vai para uma lápide única
  (`<CLAUDE_PID>.dead-<nonce>`, `rename` que só um consegue), conferida (se nela está outro dono,
  alguém armou no meio e ela volta) e apagada; então o `rename` é tentado mais uma vez e elege um
  só. Fica no disco, não numa porta: com uma porta por processo as travas do mesmo host colidiam
  entre si e com a do poller. A cada 2 s o vigia confere que `CLAUDE_PID` vive (SIGKILL no Claude Code
  deixa o hook órfão) e relê a sessão do processo (`/clear` troca o id sem matar o hook).
- **Pedido inteiro.** O pedido na caixa nasce de um temporário já escrito, ligado (`link`) no
  lugar sem sobrescrever; o estado é o nome do arquivo (`.json`, `.picked-<ms>`, `.fallback`;
  `.picked` sem hora, da versão anterior, conta como pego há tempo indefinido).
- **Uma consulta por host.** Quem segura a trava de host `claude.poller` roda a mesma consulta dos outros
  harnesses (ref com ETag a cada 30 s, notas, status das releases) e grava `claude.alive`. Chamar
  uma sessão = gravar o pedido em `claude/inbox/<sessionId>/`. Dono da trava morto → outro vigia
  assume na volta seguinte. A consulta roda em segundo plano dentro do vigia: git, histórico de
  releases e cópias nunca atrasam a caixa da própria sessão nem a conferência do `CLAUDE_PID`. O
  chamado pego sai na hora, sem esperar a consulta em curso; só uma cópia ou sessão nova que ela
  esteja abrindo termina antes (cada uma com o próprio prazo).
- **Acordar.** O vigia da sessão pega o pedido, escreve o prompt no stderr e sai 2. O Claude Code
  mostra `agent-recall: chamado de release` e entrega ao modelo o `rewakeMessage` (o responsável
  instalou o vigia; execute o pedido) seguido do prompt: sessão ociosa acorda na hora, ocupada
  recebe quando a ferramenta em curso volta. O hook seguinte rearma o vigia.
- **Confirmação.** O chamado de incidente vale quando o vigia da sessão pega o pedido (o nome do
  arquivo passa a `.picked-<ms>`), como o prompt aceito no Paseo e no OpenCode. O de release
  barrada vale só quando a nota barrada nomeia a sessão (`owner` ou `fix.session`): pegar não é
  assumir, e o Claude Code pode recusar um despertar como evento automático; é julgado só com as
  notas barradas em dia nesta volta. A cópia sai quando a sessão não tem processo do Claude Code
  vivo no host (na hora), quando tem processo sem vigia (turno ocupado depois de um chamado) há 2
  min, quando o vigia armado não pega em 10 min (vigia travado), ou, na release barrada, quando
  pegou há 2 min sem assumir. O dono da consulta abre a cópia em segundo plano: `claude --bg
  --fork-session --resume <id> "<prompt>"` no `cwd` da primeira linha do transcript
  (`~/.claude/projects/*/<id>.jsonl`; o resume não restaura o diretório), conferida em `claude
  agents --json --all`. Sessão em segundo plano só edita dentro de uma worktree isolada (padrão
  `worktree.bgIsolation`). Com a original fechada (sem processo do Claude Code vivo para ela no
  host), a cópia leva `--settings '{"worktree":{"bgIsolation":"none"}}'` e pode editar o checkout
  da original; com a original ainda viva a cópia fica na worktree isolada padrão, para as duas não
  editarem o mesmo checkout ao mesmo tempo. O `--settings` é uma camada a mais (fonte
  `flagSettings`), só deste comando: as configurações do usuário e do projeto seguem valendo, e o
  projeto não muda. A cópia falhou → `recall` na nota (a barrada, para release barrada).
- **Sem Claude Code aberto no host** ninguém ouve: o heartbeat para e o `watch` escala em 10 min,
  como para qualquer harness parado.
- Nada vai para o stdout; o log fica em `~/.local/state/agent-recall/claude/watch.log` (gira em
  1 MiB). O Claude Desktop sobe hooks com PATH curto (no macOS sem `/opt/homebrew/bin`): o
  `bin/watch.sh` acrescenta `~/.local/bin`, os shims do mise, o Homebrew, `/usr/local/bin` e o
  sistema ao PATH do vigia e do que ele roda (gh, git, claude) e usa o primeiro node 20 ou mais
  novo. O bundle é `claude/dist/watch.mjs`: o `claude/` instalado não tem `package.json` com
  `"type": "module"`, e um Node sem detecção de sintaxe (20.18) leria `.js` como CommonJS.

Vale igual no CLI, no Claude Desktop local e no Claude Desktop em modo SSH: o plugin carrega da
máquina onde o Claude Code roda.

## Limites conhecidos

- **Chamado perdido.** A trava `mkdir` de cada chamado vale uma vez. Um poller que morre (ou um
  vigia que acorda a própria sessão, ou recebe SIGTERM) entre tomar o chamado e entregá-lo perde
  esse chamado; a rede de segurança é o `watch` da release, que escala em 10 min o incidente que
  ninguém assume. Pela mesma razão, uma cópia (`.fallback`) interrompida não é refeita. No Paseo e
  no OpenCode a espera da confirmação de uma release barrada fica em memória: o poller que
  reinicia (autoatualização do Paseo inclusive) nos 2 min perde a cópia daquele chamado; o run
  vermelho segue avisando o humano pelo GitHub.
- **Porta tomada.** Outro programa na porta de uma trava deixa o host sem aquela trava (log
  `porta <n> ocupada por outro programa: este host não consulta`): sem consulta, o heartbeat para
  e o push com trailer do harness é recusado com o comando de instalação.
- **Troca de versão.** Um poller da versão anterior (trava por arquivo) e um da nova (trava TCP)
  consultam juntos até o processo antigo reiniciar. Inofensivo: a trava `mkdir` de cada chamado
  impede chamado duplo. Arquivos de trava antigos não são lidos; `.picked` sem hora é. O arquivo
  `claude/armed/<CLAUDE_PID>` da versão anterior vira diretório quando o vigia novo arma, e os
  dois vigias podem coexistir até o antigo sair: pegar o pedido é um `rename` atômico, então a
  sessão não recebe o chamado duas vezes.
- **Pid reaproveitado.** O mapa `claude/pids/<CLAUDE_PID>`, a vida do `CLAUDE_PID` e o `holder`
  de `claude/armed/<CLAUDE_PID>` são só pid: um pid reaproveitado mantém um vigia órfão vivo, ou
  faz um processo novo parecer já ter vigia, até o `timeout` de 24 h do hook; a pista de "sessão
  com vigia" pode adiar uma cópia para 10 min.
- **Hook de 24 h.** Sessão ociosa por mais de 24 h perde o vigia (o Claude Code o mata sem aviso)
  até o próximo turno ou ferramenta.
- Um processo node por processo do Claude Code; o `sh` do `bin/watch.sh` não roda no Windows
  nativo.

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

# Claude Code (carrega na próxima sessão)
claude plugin marketplace add dboltbr/agent-recall
claude plugin install agent-recall@agent-recall
```

Para testar um checkout sem instalar: `claude --plugin-dir <checkout>/claude`.

Conferir: `bash scripts/agent-recall.sh check` no dbolt, `paseo plugin logs agent-recall`, ou
`cat ~/.local/state/agent-recall/*.alive`.

## Autoatualização

Na partida e a cada 30 min, uma agenda por processo, em segundo plano e com prazo de 60 s, o plugin
pede ao próprio harness a revisão mais nova (`core/self-update.ts`). Falha só vai para o log. O
plugin recarregado entrega a própria atualização à agenda em curso, sem abrir outra; o `stop()` do
Paseo cancela a agenda.

- **OpenCode**: `opencode plugin update <spec>`, com o spec lido do `package.json` da instalação
  em `…/opencode/npm/…/node_modules/agent-recall/`. O OpenCode só confere atualização ao reiniciar
  e não instala; a revisão nova carrega no reinício seguinte. Arquivo copiado, caminho local e
  spec fixado num commit são ignorados.
- **Paseo**: `paseo plugin update agent-recall --check --json`; só numa instalação `git` com
  revisão nova aplica `--yes`, e o Paseo recarrega o plugin na hora. Instalação `directory`
  (checkout de dev) é ignorada. O commit tentado fica em `~/.local/state/agent-recall/paseo.update`
  e não é reaplicado em 30 min, então um Paseo que siga propondo a mesma revisão não entra em laço.
- **Claude Code**: o vigia que segura a consulta do host roda `claude plugin marketplace update
  agent-recall` e `claude plugin update agent-recall@agent-recall --scope user`, no máximo uma vez a
  cada 30 min no host (`~/.local/state/agent-recall/claude.update`). Só com o marketplace do
  GitHub; o de diretório (checkout de dev) é ignorado. A revisão nova vale na sessão seguinte.

## Configuração do host

`~/.config/agent-recall/config.json`:

```json
{
  "instance": "archdev",
  "repository": "dboltbr/dbolt",
  "notesRef": "refs/notes/release-watch",
  "blockedRef": "refs/notes/release-blocked"
}
```

- `instance`: nome do host nos trailers `opencode/<instance>/…` e `claude/<instance>/…` (o Paseo
  usa o `server-id`).
- `notesRef`: `refs/notes/release-watch-drill` no ensaio.
- `blockedRef`: opcional; padrão `refs/notes/release-blocked`, ou `refs/notes/release-blocked-drill`
  quando o `notesRef` é o de ensaio.
- `incidentHost` + `incidentCheckout`: opcionais; `true` e o checkout do dbolt fazem deste host o
  que abre o agente de uma release barrada que nenhuma sessão da faixa assume. Sem
  `incidentCheckout`, `incidentHost` não vale.

## Desenvolvimento

```bash
npm install
npm test             # node:test, relógio fixo, TMPDIR próprio: falha se um teste deixa temporário
npm run typecheck
npm run bundle       # server/core/ e shared/ (cópias de core/ para o Paseo) + dist/agent-recall.js + claude/dist/watch.mjs
claude plugin validate .   # marketplace e plugin do Claude Code
```

`server/core/`, as cópias em `shared/`, `dist/agent-recall.js` e `claude/dist/watch.mjs` são gerados e
vão no commit: o Paseo e o OpenCode instalam direto do git (`main`/`exports` do `package.json` apontam
para o bundle) e o Claude Code copia o diretório `claude/` do git, sem `npm install`. O plugin do
Claude Code não declara `version`: o Claude Code acompanha o commit. O script
se chama `bundle`, não `build`: o npm do OpenCode roda `build` ao preparar dependência git e falha.

Copyright DBolt. All rights reserved.
