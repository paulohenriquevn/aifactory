import { SANDBOX_TEMPLATE_MISSING } from '../../../shared/panel'
import { settingsOff, type DoctorTriedSentences } from '../../../shared/doctor-say'

import type { Copy } from './en'

/** What the doctor tried to read, after "Não sei:". */
const TRIED: DoctorTriedSentences = {
  settings: (v) => `ler as configurações de ${v.repo}`,
  branches: (v) => `ler as branches de ${v.repo}`,
  labels: (v) => `ler os labels de ${v.repo}`,
  required: (v) => `ler os checks que ${v.integration} exige em ${v.repo}`,
  recent: (v) => `ler os checks dos commits recentes de ${v.integration} em ${v.repo}`,
  publish: (v) => `ler como ${v.repo} publica`,
  recipe: (v) => `ler ${v.path} de ${v.repo}`,
  installation: (v) => `ler a instalação do GitHub App em ${v.repo}`,
  events: () => 'ler os eventos que o GitHub App assina',
  runs: (v) => `ler as execuções que falharam em ${v.repo}`,
  sandboxes: () => 'listar os sandboxes que a conta tem ativos',
  token: (v) => `gerar um token para ${v.repo}`,
  merge_settings: (v) => `ler as configurações de merge de ${v.repo}`,
}

/** What was tried, in Portuguese when the code is one this panel knows, and as the server said it otherwise. */
const tried = (v: Record<string, string>) => TRIED[v.what as keyof typeof TRIED]?.(v) ?? v.tried

/** How a read failed, in Portuguese; the raw error stays in it when the kind is not one this panel knows. */
const failure = (v: Record<string, string>) => {
  if (v.errorKind === 'github_status') {
    return `o GitHub respondeu ${v.errorStatus}${v.errorDetail ? `: ${v.errorDetail}` : ''}`
  }
  if (v.errorKind === 'network') return `a conexão falhou: ${v.error}`
  if (v.errorKind === 'app_not_installed') {
    return `o GitHub App não está instalado em ${v.errorRepo}`
  }
  return v.error ?? ''
}

/** Why a recipe cannot be used, by kind. */
const TYPES: Record<string, string> = {
  string: 'um texto',
  array: 'uma lista',
  object: 'um objeto',
  number: 'um número',
  boolean: 'verdadeiro ou falso',
}
/** What a field has too few or too many of: the characters of a text, the items of a list. */
const unitOf = (v: Record<string, string>, n: string) =>
  v.origin === 'array'
    ? `${n} ${n === '1' ? 'item' : 'itens'}`
    : `${n} ${n === '1' ? 'caractere' : 'caracteres'}`

/** The rule an invalid recipe broke, in Portuguese; the English reason for a rule not listed. */
const RULES: Record<string, (v: Record<string, string>) => string> = {
  type: (v) => `deve ser ${TYPES[v.expected ?? ''] ?? v.expected ?? 'de outro tipo'}`,
  too_small: (v) => `deve ter ao menos ${unitOf(v, v.limit ?? '')}`,
  too_big: (v) => `deve ter no máximo ${unitOf(v, v.limit ?? '')}`,
  unknown_keys: (v) => `tem campos que a receita não conhece: ${v.keys}`,
  hostname: () => 'não é um nome de host',
}

const RECIPE_WHY: Record<string, (v: Record<string, string>) => string> = {
  not_json: (v) => {
    const place = v.line
      ? ` (linha ${v.line}, coluna ${v.column})`
      : v.position
        ? ` (posição ${v.position})`
        : ''
    return `ele não é um JSON válido${place}`
  },
  invalid: (v) => {
    const rule = RULES[v.rule ?? '']
    return rule ? `${v.at || 'o arquivo'} ${rule(v)}` : (v.detail ?? '')
  },
  status: (v) => `o GitHub respondeu ${v.detail} ao lê-lo`,
}

/** The panel's text in Brazilian Portuguese. Typed against English: a missing or extra key does not compile. */
export const ptBR: Copy = {
  layout: {
    loading: 'Carregando…',
    ownerName: 'dono',
    ownerRole: 'dono da fábrica',
  },
  places: {
    board: 'Quadro',
    plans: 'Planos',
    repositories: 'Repositórios',
    inbox: 'Caixa de entrada',
    health: 'Saúde',
    agents: 'Agentes',
    setup: 'Configuração',
  },
  menu: {
    label: 'Menu',
    folded: 'Menu recolhido',
    main: 'Principal',
    show: 'Mostrar o menu',
    hide: 'Recolher o menu',
    newChat: 'Novo chat',
    searchChats: 'Buscar conversas',
    searchInChats: 'Buscar nas conversas',
    pinned: 'Fixados',
    recent: 'Recentes',
    chats: 'Conversas',
    noneFound: 'Nenhuma conversa encontrada',
    noneYet: 'Nenhuma conversa ainda',
    account: 'Conta',
    signOut: 'Sair',
  },
  chatRow: {
    name: 'Nome da conversa',
    options: (title) => `Opções de ${title}`,
    pin: 'Fixar',
    unpin: 'Desafixar',
    rename: 'Renomear',
    remove: 'Apagar',
    confirmRemove: (title) => `Apagar "${title}"?`,
  },
  topBar: {
    part: 'Parte do app',
    chat: 'Chat',
    work: 'Trabalho',
    guide: 'Guia',
    openGuide: (name) => `Abrir o ${name}`,
    closeGuide: (name) => `Fechar o ${name}`,
    lightTheme: 'Tema claro',
    darkTheme: 'Tema escuro',
    language: 'Idioma',
    switchLanguage: 'Switch to English',
    languageName: 'Português',
  },
  work: {
    board: 'Quadro',
    list: 'Lista',
    viewGroup: 'Visão',
    backToBoard: '← Quadro',
    opened: 'Abriu a',
    issue: (n: number) => `issue #${n}`,
    startedNote: '. A fábrica começa a trabalhar nela em instantes.',
    waitsNote: '. Ela espera até você mandar começar.',
    emptyTitle: 'Nenhuma tarefa ainda',
    emptyPut: 'Coloque o rótulo',
    emptyAfter: 'em uma issue e ela aparece aqui. Primeira vez por aqui?',
    checkSetup: 'Veja a configuração',
    sheetTitle: 'Tarefa',
    sheetDescription: 'Detalhes da tarefa selecionada',
    openInFull: 'Abrir em tela cheia',
  },
  board: {
    nothingHere: 'Nada aqui.',
    mainRedAfterRelease: 'a main quebrou depois da versão',
    mainRed: 'main quebrada',
    waitingOnBase: (checks: string, branch: string) => `espera ${checks} passar em ${branch}`,
    returned: {
      base_conflict: 'Voltou: conflito com a base',
      ci_red: 'Voltou: a CI falhou',
      base_fixed: 'Voltou: trazendo a base corrigida',
      review: 'Voltou: mudanças pedidas',
      other: 'Voltou de Entregue',
    },
    returnedWhen: (label: string, when: string) => `${label} · ${when}`,
    merge: {
      merging: (n: number) => `${n} fazendo merge`,
      opening_pr: (n: number) => `${n} abrindo o PR`,
      waiting_for_checks: (n: number) => `${n} aguardando CI`,
      awaiting_merge: (n: number) => `${n} aguardando merge`,
    },
    queuePlace: (n: number) => `${n}ª na fila`,
    queueHeld: 'retida na fila',
    topRank: (n: number) => `${n}ª posição do top 10`,
    restOfQueue: 'resto da fila',
    priority: (n: number) => `prioridade ${n}`,
    priorityBadge: (n: number) => `P${n}`,
    bug: 'bug',
    unblocks: (n: number) => `desbloqueia ${n}`,
    ready: 'pronta para construir',
    needsRefinement: (missing: string) =>
      missing ? `precisa de refinamento: ${missing}` : 'precisa de refinamento',
    attempt: (n: number) => `tentativa ${n} de 3`,
    leadTime: {
      on_track: 'No prazo',
      at_risk: 'Em risco',
      overdue: 'Estourado',
      running: (time: string, status: string) => `Lead time ${time} · ${status}`,
      delivered: (time: string, status: string) => `Entregue em ${time} · ${status}`,
    },
    steps: {
      planning: 'planejando',
      building: 'construindo',
      fixing: 'corrigindo achados',
      reviewing: 'revisando',
      checks: 'verificações',
    },
    stepAttempt: (n: number) => `tentativa ${n}`,
    reviewRound: (n: number) => `rodada ${n}`,
    lastAgent: (who: string) => `por último: ${who}`,
    lastWorked: 'por último',
    tasks: 'Tarefas',
    task: 'Tarefa',
    repository: 'Repositório',
    stage: 'Etapa',
    cost: 'Custo',
    updated: 'Atualizada',
  },
  columns: {
    queued: 'Na fila',
    working: 'Em andamento',
    waiting: 'Esperando você',
    retrying: 'Vai tentar de novo',
    merge: 'Merge',
    review: 'Entregue',
    released: 'Publicada',
    resolved: 'Já resolvida',
    attention: 'Precisa de uma pessoa',
  },
  stages: {
    intake: 'na fila',
    sandbox: 'preparando o ambiente',
    plan: 'planejando',
    build: 'construindo',
    push: 'enviando o código',
    verify: 'rodando as verificações',
    review: 'em revisão',
    waiting: 'esperando você',
    merge: 'em merge',
    pr: 'abrindo o pull request',
    done: 'pull request aberto',
    released: 'publicada',
    handoff: 'passada para uma pessoa',
    failed: 'falhou',
    cancelled: 'cancelada',
    alreadyResolved: 'já resolvida',
    integrated: 'integrada',
    waitingForChecks: 'esperando a CI',
    awaitingMerge: 'aprovada, aguardando merge',
    waitingForLimit: 'esperando o limite',
    willRetry: 'vai tentar de novo',
    waitingForIssue: 'esperando outra issue',
    waitingForBase: 'esperando a base passar',
    passed: 'passou',
    checkFailed: 'falhou',
  },
  time: {
    secondsAgo: (n: number) => `há ${n}s`,
    minutesAgo: (n: number) => `há ${n}min`,
    hoursAgo: (n: number) => `há ${n}h`,
    daysAgo: (n: number) => `há ${n}d`,
    runsNextPass: 'roda de novo na próxima passada',
    runsUnderMinute: 'roda de novo em menos de um minuto',
    runsInMinutes: (n: number) => `roda de novo em ${n}min`,
    runsInHours: (n: number) => `roda de novo em ${n}h`,
    runsInDays: (n: number) => `roda de novo em ${n}d`,
  },
  newJob: {
    open: 'Novo trabalho',
    title: 'Novo trabalho',
    description:
      'Abre uma issue no GitHub. Com \u201cComeçar agora\u201d a fábrica começa assim que ela é criada.',
    enableFirst: 'Primeiro, ative um repositório em Repositórios.',
    loading: 'Lendo os seus repositórios…',
    repository: 'Repositório',
    titleField: 'Título',
    bodyField: 'O que ele deve fazer, e como você vai saber que funcionou?',
    startNow: 'Começar agora',
    create: 'Criar trabalho',
    close: 'Fechar',
  },
  task: {
    loading: 'Carregando…',
    attempts: (n: number) => `${n} de 3 tentativas`,
    preRelease: (tag: string) => `Pré-lançamento ${tag}`,
    release: (tag: string) => `Lançamento ${tag}`,
    pullRequest: 'Pull request',
    questions: 'Perguntas',
    replyHint: 'Responda em um comentário na issue, como alguém com permissão de escrita.',
    answered: (by: string, answer: string) => `${by} respondeu: ${answer}`,
    deliveries: 'Entregas',
    deliveryRelease: 'Lançamento',
    deliveryPreRelease: 'Pré-lançamento',
    deliveryMeta: (sha: string, actor: string, when: string) => `em ${sha} por ${actor} · ${when}`,
    timeline: 'Linha do tempo',
    transcript: 'O que os agentes fizeram',
    executions: 'Execuções',
    role: 'Papel',
    model: 'Modelo',
    notRecorded: 'não registrado',
    tokens: 'Tokens (entrada / saída)',
    agent: 'Agente',
    attempt: 'Tentativa',
    cost: 'Custo',
    time: 'Tempo',
    result: 'Resultado',
    notReported: 'não informado',
    seconds: (n: string) => `${n} s`,
    outOfQuota: 'sem cota',
    finished: 'terminou',
    failed: 'falhou',
    evidence: 'Evidências',
    noChecks: 'Nenhuma verificação rodou ainda.',
    evidenceMeta: (sha: string, exit: number, secs: string) =>
      `em ${sha} · saída ${exit} · ${secs} s`,
    output: 'Saída',
    reviews: 'Revisões',
    notReviewed: 'Ainda não foi revisada.',
    reviewLine: (round: number, verdict: string) => `Tentativa ${round}: ${verdict}`,
    reviewedOn: (reviewer: string, sha: string) => `${reviewer} em ${sha}`,
  },
  taskActions: {
    title: 'Ações',
    heading: 'O que você quer fazer?',
    waitingForChecks:
      'O GitHub une este pull request assim que as verificações exigidas do repositório passarem, e a fábrica termina a integração depois. Uma verificação que falhar devolve o trabalho ao agente.',
    waitingOnBase: (checks: string, branch: string) =>
      `Esta tarefa espera ${checks} passar na branch de integração ${branch}: as verificações que ela falhou falham lá também, então não são dela. A fábrica segue quando a branch passar.`,
    releaseWaitBefore: 'O pull request do lançamento',
    releaseWaitAfter: (checks: string) =>
      `espera as verificações exigidas da branch de lançamento: ${checks}. O GitHub o une assim que passarem, e a fábrica termina o lançamento depois. Uma verificação que falhar interrompe o lançamento, e o motivo aparece aqui.`,
    releaseRefused: (reason: string) => `O último lançamento não aconteceu: ${reason}.`,
    approve: 'Aprovar esta versão',
    approved: 'Aprovada',
    approvedMessage: 'Aprovada nesta versão.',
    versionBump: 'Aumento da versão',
    patch: 'correção',
    minor: 'pequena novidade',
    major: 'grande mudança',
    release: 'Lançar',
    confirmRelease:
      'Levar a branch de pré-lançamento para a branch principal e publicar um lançamento? Tudo o que está na branch de pré-lançamento vai junto. Isto não pode ser desfeito por aqui.',
    released: 'Lançado.',
    releaseWaits: (checks: string) =>
      `O lançamento espera as verificações da branch de lançamento (${checks}): o GitHub o une assim que passarem.`,
    retry: 'Tentar de novo',
    confirmRetry: 'Recomeçar do zero? A branch e o pull request dela serão apagados.',
    retried: 'Recomeçou.',
    askChanges: 'Pedir mudanças',
    changesPlaceholder: 'O que deve mudar? O agente continua a partir da branch que ele enviou.',
    sendBack: 'Devolver',
    sentBack: 'Devolvido ao agente.',
    sendBackWaiting: 'Uma devolução espera a execução começar. Retire-a para corrigir a nota.',
    withdraw: 'Retirar devolução',
    confirmWithdraw: 'Retirar esta devolução? A execução não começa e a tarefa volta.',
    withdrawn: 'Devolução retirada.',
    changesContext: (title: string, n: number, repository: string) =>
      `Pull request da issue "${title}" (#${n}) em ${repository}`,
    resolvedAnotherWay: 'Resolvida de outro jeito',
    resolvePlaceholder:
      'Onde foi resolvida? Um pull request que você fez à mão, ou as issues em que ela foi dividida.',
    resolveContext: (title: string, n: number, repository: string) =>
      `A fábrica não conseguiu entregar a issue "${title}" (#${n}) em ${repository}`,
    markResolved: 'Marcar como resolvida',
    resolvedMessage: 'Marcada como entregue de outro jeito.',
  },
  transcript: {
    waitingFirst: 'Esperando o primeiro passo do agente…',
    none: 'Nenhum passo foi registrado para esta tarefa.',
    builder: 'Construtor',
    reviewer: 'Revisor',
  },
  retryWaiting: {
    button: 'Refazer as tarefas que esperavam a conta',
    none: 'Nenhuma tarefa estava esperando.',
    started: (n: number) => `${n} ${n === 1 ? 'tarefa começou' : 'tarefas começaram'} de novo.`,
  },
  doctor: {
    title: 'Saúde do repositório',
    blocked: 'Bloqueado',
    warn: 'Atenção',
    unknown: 'Não deu para ler',
    fix: 'Corrigir',
    fixing: 'Corrigindo…',
    open: 'Abrir',
    checkAgain: 'Verificar de novo',
    checking: 'Verificando…',
    ready: (when: string) => `Este repositório está pronto. Verificado ${when}.`,
    repair: 'Como resolver:',
    loading: 'Lendo o repositório…',
    unprovenLine: (names: string) => `Estas verificações ainda não foram provadas: ${names}.`,
    allProven: 'Todas as verificações salvas já foram provadas.',
    prove: 'Provar estas verificações',
    proving: 'Provando…',
    passed: 'Passou',
    failed: 'Falhou',
    tooSlow: 'Lenta demais',
    seconds: (n: string) => `${n} s`,
    proofFailed: (reason: string) => `A prova não pôde rodar: ${reason}`,
    integrationUnprovenLine: (names: string) =>
      `Estes checks de integração ainda não foram provados: ${names}.`,
    integrationAllProven: 'Todos os checks de integração salvos já foram provados.',
    proveIntegration: 'Provar estes checks de integração',
    setupLine:
      'Rodadas antes, para que os checks de integração encontrem o projeto instalado. Não são salvas e não decidem nada:',
    say: {
      unknown: {
        cause: (v) =>
          `Não sei: ${tried(v)} falhou (${failure(v)}). Nada é dado como certo sem ter sido lido.`,
        repair: () => 'Verifique de novo daqui a pouco.',
      },
      unknown_unanswered: {
        cause: (v) =>
          `Não sei: ${tried(v)} falhou (o GitHub deixou isso de fora da resposta). Nada é dado como certo sem ter sido lido.`,
        repair: () => 'Verifique de novo daqui a pouco.',
      },
      issues_off: {
        cause: (v) =>
          `As Issues estão desligadas em ${v.repo}, então ninguém consegue pedir trabalho à fábrica ali.`,
        repair: () =>
          'Ligue as Issues em Settings, General, Features. Um fork começa com as Issues desligadas. Se você não pode mudar as configurações, peça a um administrador do repositório.',
      },
      app_unreachable: {
        cause: (v) => `O GitHub App não alcança ${v.repo}.`,
        repair: () =>
          'Adicione o repositório à instalação do App, na página da conta que é dona dele.',
      },
      app_lacks: {
        cause: (v) => `Falta à instalação do GitHub App em ${v.repo}: ${v.lacking}.`,
        repair: () =>
          'Aceite as permissões que o App pede na página da instalação; o GitHub mostra o pedido lá.',
      },
      app_events: {
        cause: (v) =>
          `O App não assina ${v.missing}, então o GitHub nunca avisa a fábrica quando isso acontece.`,
        repair: (v) =>
          v.owner
            ? `Ligue os eventos que faltam em "Subscribe to events", nas configurações do App. A página só abre se você estiver logado no GitHub como ${v.owner}, a conta dona do App.`
            : 'Ligue os eventos que faltam em "Subscribe to events", nas configurações do App.',
      },
      branches_missing: {
        cause: (v) => `${v.repo} não tem a branch ${v.missing}.`,
        repair: () => 'A fábrica consegue criar o que falta a partir da branch de release.',
      },
      label_missing: {
        cause: (v) =>
          `${v.repo} não tem o label "factory", que é o que pede à fábrica para pegar uma issue.`,
        repair: () => 'A fábrica consegue criar o label.',
      },
      auto_merge_off: {
        cause: (v) =>
          `${v.integration} exige checks, então a fábrica espera por eles com o auto-merge, e ${v.repo} está com ${settingsOff(v).join(', ')} desligado.`,
        repair: (v) => `Ligue ${settingsOff(v).join(' e ')} em Settings, General, Pull Requests.`,
      },
      ci_silent: {
        cause: (v) =>
          `${v.integration} exige ${v.silent}, que não apareceu em nenhum dos ${v.commits} commits e pull requests mais recentes: um workflow está desativado, ou nada o dispara.`,
        repair: (v) =>
          `Abra a aba Actions: reative um workflow que o GitHub desligou por inatividade, ou faça o workflow rodar em pull requests para ${v.integration}.`,
      },
      checks_alone: {
        cause: (v) =>
          `${v.integration} exige ${v.alone}, e nenhum check da fábrica tem esse nome: a fábrica só saberia de uma falha pelo CI, depois de os próprios checks passarem.`,
        repair: () =>
          'Adicione um check que rode o mesmo comando aos checks do repositório no painel, ou ao .factory/setup.json.',
      },
      tag_no_version: {
        cause: (v) =>
          `tag: ${v.workflow} roda quando uma tag é criada, e o package.json em ${v.ref} não tem versão para comparar com a próxima tag.`,
        repair: () =>
          'Antes de promover, ponha no package.json a versão que a release vai ter, ou publique com changesets.',
      },
      tag_mismatch: {
        cause: (v) =>
          `tag: ${v.workflow} roda quando uma tag é criada, e o package.json em ${v.ref} está em ${v.version}, enquanto a próxima tag seria ${v.next}: o que o workflow publica não teria a versão da tag.`,
        repair: () =>
          'Antes de promover, ponha no package.json a versão que a release vai ter, ou publique com changesets.',
      },
      recipe_problem: {
        cause: (v) => {
          const why = RECIPE_WHY[v.kind ?? '']
          return why
            ? `${v.repo}: ${v.path} na branch padrão não pode ser usado: ${why(v)}`
            : (v.problem ?? '')
        },
        repair: () =>
          'Corrija o .factory/setup.json na branch padrão: uma execução para pelo mesmo motivo.',
      },
      recipe_pending: {
        cause: (v) =>
          `A receita pede ${v.pending}, que o sandbox só alcança depois que você aprovar.`,
        repair: () => 'Aprove os domínios na página do repositório, no painel.',
      },
      sandbox_refused: {
        cause: (v) =>
          `O provedor de sandbox recusou a última execução deste repositório (tarefa ${v.taskId}, ${v.at}): ${v.error}${v.up ? ` ${v.up} de ${v.limit} sandboxes estão ativos, ${v.atWork} com dono trabalhando.` : ''}`,
        repair: (v) =>
          SANDBOX_TEMPLATE_MISSING.test(v.error ?? '')
            ? 'Construa o template do sandbox: node --env-file=.env.local scripts/build-e2b-template.mts. A tarefa tenta de novo sozinha quando o provedor o tiver.'
            : 'Ponha crédito no provedor de sandbox, ou corrija a chave dele no servidor. A tarefa tenta de novo sozinha quando o provedor aceitar.',
      },
      ok_issues: { cause: () => 'As Issues estão ligadas.', repair: () => '' },
      ok_app_access: {
        cause: (v) => `O GitHub App alcança ${v.repo} com todas as permissões de que precisa.`,
        repair: () => '',
      },
      ok_app_events: {
        cause: () => 'O App assina todos os eventos que a fábrica lê.',
        repair: () => '',
      },
      ok_branches: {
        cause: () => 'As branches de integração e de pré-release existem.',
        repair: () => '',
      },
      ok_label: { cause: () => 'O label "factory" existe.', repair: () => '' },
      ok_auto_merge_free: {
        cause: (v) =>
          `${v.integration} não exige checks, então a fábrica faz o merge dos próprios pull requests.`,
        repair: () => '',
      },
      ok_auto_merge_allowed: {
        cause: (v) =>
          `${v.integration} exige checks, e ${v.repo} permite auto-merge e commits de merge.`,
        repair: () => '',
      },
      ok_ci_free: {
        cause: (v) => `${v.integration} não exige nenhum check do repositório.`,
        repair: () => '',
      },
      ok_ci_reported: {
        cause: (v) => `Todo check exigido por ${v.integration} apareceu em um commit recente.`,
        repair: () => '',
      },
      ok_checks_parity: {
        cause: (v) => `Todo check exigido por ${v.integration} tem um check da fábrica.`,
        repair: () => '',
      },
      ok_tag: {
        cause: (v) =>
          `tag: ${v.workflow} roda quando uma tag é criada, e o package.json em ${v.ref} está em ${v.version}, uma versão que a próxima tag pode ter.`,
        repair: () => '',
      },
      ok_changesets: {
        cause: (v) =>
          `changesets: .changeset/config.json está em ${v.ref}, então o workflow de release de ${v.repo} cria as próprias tags.`,
        repair: () => '',
      },
      ok_none: {
        cause: (v) =>
          `none: ${v.repo} não tem .changeset/config.json nem workflow que rode numa tag, então a fábrica cria as tags de release e nada mais é publicado.`,
        repair: () => '',
      },
      ok_recipe: {
        cause: () => 'A receita não tem problema nem domínio esperando aprovação.',
        repair: () => '',
      },
      ok_sandbox: {
        cause: () => 'O provedor de sandbox não recusou a última execução.',
        repair: () => '',
      },
      ok_sandbox_slots: {
        cause: (v) =>
          `O provedor de sandbox não recusou a última execução. ${v.up} de ${v.limit} sandboxes estão ativos, ${v.atWork} com dono trabalhando.`,
        repair: () => '',
      },
    },
    tried: TRIED,
  },
  assist: {
    label: {
      goal: 'Me ajude a dizer',
      job: 'Me ajude a dizer',
      issue: 'Melhorar isto',
      changes: 'Me ajude a dizer',
      resolution: 'Me ajude a dizer',
      setup: 'Configure para mim',
    },
    working: 'Trabalhando nisso…',
    needsWords: 'Escreva algumas palavras primeiro.',
    suggestion: 'Sugestão',
    extraDomains: (domains) => `Domínios extras: ${domains}`,
    use: 'Usar isto',
    dismiss: 'Descartar',
    askChange: 'Pedir uma mudança',
    changePlaceholder: 'Quer diferente? Diga o quê, com as suas palavras',
    change: 'Mudar',
  },
  lineAlert: {
    region: 'Linhas paradas',
    line: (repository: string, surface: string, forHow: string) =>
      `${repository}: linha parada há ${forHow}, ${surface} está vermelha. Nada mais roda nem integra ali até ficar verde.`,
    lineFixFirst: (repository: string, surface: string, forHow: string) =>
      `${repository}: linha parada há ${forHow}, ${surface} está vermelha. A correção vai na frente; o resto continua rodando.`,
    fix: (issue: number, attempt: number) =>
      attempt > 1 ? `Correção #${issue}, tentativa ${attempt}` : `Correção #${issue}`,
    person: (issue: number) => `#${issue} precisa de uma pessoa`,
  },
  baseAlert: {
    region: 'Branches de integração vermelhas',
    line: (repository: string, branch: string, checks: string, held: number, forHow: string) =>
      `${repository}: ${branch} está vermelha há ${forHow} em ${checks}, segurando ${held} ${held === 1 ? 'entrega' : 'entregas'}.`,
  },
  pulse: {
    region: 'Métricas da fábrica',
    show: 'Ver métricas',
    hide: 'Esconder métricas',
    groups: { speed: 'Velocidade', efficiency: 'Eficiência', quality: 'Qualidade' },
    labels: {
      deliveredLastHour: 'Entregas na última hora',
      perHour: 'Por hora, últimas 24h',
      leadTime: 'Lead time mediano, 24h',
      deliveredLast24Hours: 'Entregas em 24h',
      queued: 'Na fila',
      working: 'Em andamento',
      first_pass_checks: 'Checks verdes de primeira',
      cost_per_delivery: 'Custo por entrega',
      rework_rounds: 'Rodadas de retrabalho por tarefa',
      first_review_approval: 'Aprovadas na 1ª revisão',
      change_failure: 'Entregas que voltaram',
      handoff_share: 'Passadas para uma pessoa',
    } as Record<string, string>,
    out: 'fora da faixa normal',
    drift: 'desviando',
    day: (day: string) => `medido em ${day}`,
  },
  leadTimeLimits: {
    atRisk: 'Minutos até uma tarefa ficar em risco',
    overdue: 'Minutos até uma tarefa estourar o prazo',
    atRiskPlaceholder: 'Vazio: o padrão da fábrica (120 minutos, 2 horas)',
    overduePlaceholder: 'Vazio: o padrão da fábrica (480 minutos, 8 horas)',
    help: 'O lead time conta do momento em que a issue entra na fábrica até a entrega do trabalho. Passado o primeiro limite, o card ganha borda âmbar; passado o segundo, borda vermelha.',
    invalid: (min: number, max: number) =>
      `Cada limite é um número inteiro de minutos, de ${min} a ${max}, e o primeiro é menor que o segundo.`,
  },
  runLimit: {
    label: 'Minutos que uma execução pode durar',
    placeholder: 'Vazio: o padrão da fábrica (90 minutos)',
    help: 'Aumente quando as verificações forem lentas e uma execução terminar por tempo antes de a revisão acabar.',
    invalid: (min: number, max: number) =>
      `Uma execução pode durar de ${min} a ${max} minutos inteiros.`,
  },
  onboarding: {
    title: 'Primeiros passos',
    stepsLabel: 'Passos para ligar um repositório',
    reopen: 'Rever este passo',
    stepState: { done: 'concluído', failed: 'falhou', pending: 'não iniciado' },
    steps: {
      connect: 'Conectar o GitHub',
      choose: 'Escolher um repositório',
      enable: 'Ligar',
    },
    connect: {
      about: 'A fábrica precisa disto para chegar ao GitHub.',
      ready: 'O GitHub está conectado.',
      loading: 'Verificando a conexão…',
    },
    choose: {
      about: 'Escolha o repositório em que a fábrica pode trabalhar.',
      search: 'Buscar repositórios',
      none: 'Nenhum repositório corresponde à busca.',
      empty:
        'O App ainda não alcança nenhum repositório. Instale-o no GitHub e escolha os repositórios.',
      private: 'privado',
      public: 'público',
      pick: 'Ligar',
      picking: 'Ligando…',
      chosen: (name: string) => `${name} está ligado.`,
      loading: 'Lendo seus repositórios…',
    },
    enable: {
      about: (name: string) =>
        `A fábrica está verificando ${name}. Resolva o que estiver bloqueado.`,
      ready: 'Nada bloqueia este repositório. Já dá para dar o primeiro trabalho a ele.',
      notRead: 'Alguns itens não puderam ser lidos, então não contam como certos.',
      firstJob: 'Abrir o primeiro trabalho',
    },
  },
  repositories: {
    title: 'Repositórios',
    refresh: 'Atualizar',
    installOnGitHub: 'Instalar no GitHub',
    loading: 'Carregando…',
    waiting:
      'Esperando o GitHub. Escolha a conta e os repositórios lá e volte: esta página percebe sozinha.',
    confirmed: 'O GitHub confirmou a instalação.',
    installedOn: (accounts: string, count: number) =>
      `Instalado em ${accounts}. ${count} repositórios estão ao alcance.`,
    inReach: (count: number) => `${count} repositórios estão ao alcance.`,
    enableBelow: 'Ative abaixo os repositórios que você quer.',
    githubFailed: 'Não deu para consultar o GitHub',
    installationsLabel: 'Instalações',
    installation: {
      installedOn: 'Instalado em',
      every: 'todos os repositórios',
      chosen: 'os repositórios escolhidos lá',
      manage: 'Gerenciar no GitHub',
      signedInAs: (account: string) =>
        `(O GitHub só mostra essa página quando você está logado como ${account}.)`,
    },
    noneTitle: 'O App ainda não alcança nenhum repositório',
    noneDescription:
      'Instale o App no GitHub e escolha os repositórios em que ele pode trabalhar. Depois, atualize.',
    private: 'privado',
    public: 'público',
    noAccess: 'O App não tem acesso',
    enabled: 'ativo',
    enable: 'Ativar',
    disable: 'Desativar',
    settings: {
      saved: 'Salvo.',
      checks: 'Verificações, uma por linha no formato nome: comando',
      checksPlaceholder: 'Vazio roda npm test. Por exemplo: unit: pnpm test',
      integrationChecks: 'Checks de integração, um por linha no formato nome: comando',
      integrationChecksPlaceholder: 'Vazio não roda nenhum. Por exemplo: e2e: pnpm test:e2e',
      integrationChecksHelp:
        'Rodam no merge do trabalho com a branch de integração, depois das verificações acima.',
      integrationChecksAssistContext:
        'Só os checks de integração: um por linha no formato nome: comando, rodados no merge do trabalho com a branch de integração depois que as verificações acima instalaram o projeto (por exemplo testes de ponta a ponta ou de banco de dados). Não as verificações acima, nem correções.',
      fixes: 'Correções, um comando por linha, rodadas antes das verificações',
      fixesAssistContext:
        'Só os comandos de correção: um comando de shell por linha que reescreve arquivos e não decide nada (um formatador, um autofix de lint), sem nome na frente. Não são verificações.',
      fixesPlaceholder: 'Vazio não roda nenhuma. Por exemplo: pnpm prettier --write .',
      domains: 'Domínios extras que o sandbox pode acessar',
      domainsPlaceholder:
        'GitHub, o agente e o registro do npm ficam sempre abertos. Para Python: pypi.org, files.pythonhosted.org',
      baseBranch: 'Branch de onde o trabalho parte',
      defaultPlaceholder: 'workspace (o padrão)',
      baseBranchHelp: (defaultBranch: string) =>
        `A fábrica junta aqui o trabalho pronto. Deixe vazio para usar workspace. A branch develop passa a levar a pré-versão, e ${defaultBranch} a versão final. As branches que faltam são criadas para você.`,
      theDefaultBranch: 'a branch padrão',
      releaseBranch: 'Branch onde a versão final chega',
      releaseBranchDefault: (defaultBranch: string) => `${defaultBranch} (o padrão)`,
      releaseBranchHelp:
        'Só é preciso quando a branch padrão é develop, onde fica a pré-versão: informe main, ou a branch que suas versões finais usam.',
      ask: 'Deixar o agente me fazer perguntas na issue quando algo não estiver claro',
      builder: 'Construtor',
      reviewer: 'Revisor',
      release: 'Versão final',
      factoryDefault: 'Padrão da fábrica',
      sameAsBuilder: 'O mesmo do construtor',
      manual: 'Só eu, pelo painel',
      trial: 'Registrar o que um agente faria',
      auto: 'Um agente pode publicar',
      save: 'Salvar configurações',
    },
  },
  setup: {
    title: 'Configuração',
    checkAgain: 'Conferir de novo',
    loading: 'Carregando…',
    status: { ok: 'pronto', warn: 'conferir', missing: 'necessário' },
    readyTitle: 'Pronto para construir',
    readyDescription: 'Planeje o trabalho ou abra uma tarefa, e a fábrica cuida do resto.',
    planTheWork: 'Planejar o trabalho',
    notReadyTitle: 'Ainda não está pronto',
    notReadyDescription: 'Resolva as linhas marcadas como necessário e confira de novo.',
  },
  login: {
    title: 'Entrar',
    token: 'Token do painel',
    submit: 'Entrar',
  },
  errorPage: {
    title: 'Algo deu errado',
    message: 'Aconteceu um erro inesperado.',
    home: 'Voltar para o início',
  },
  health: {
    title: 'Saúde',
    loading: 'Carregando…',
    findings: 'Problemas encontrados',
    nothingWrong: 'Não há nada de errado com a fábrica agora.',
    since: (when: string) => `desde ${when}`,
    task: (id: number) => `Tarefa ${id}`,
    kind: {
      run: 'Uma execução parou de andar',
      queued_run: 'Uma tarefa está na fila e nada vai executá-la',
      queue: 'As execuções na fila de um repositório não estão começando',
      answer_resume: 'Uma resposta nunca foi retomada',
      snapshot: 'Um instantâneo de que ninguém precisa',
      revert: 'Uma reversão nunca foi confirmada',
      back_merge: 'Um back-merge tem conflito e nada vai fazer o merge dele',
    },
    openOnGithub: 'Abrir no GitHub',
    actions: {
      run: {
        label: 'Recomeçar',
        confirm:
          'Recomeçar esta tarefa? A branch dela é apagada. Se a execução ainda estiver viva, duas vão disputar o mesmo trabalho.',
      },
      queued_run: { label: 'Recomeçar' },
      answer_resume: { label: 'Retomar de novo' },
      snapshot: {
        label: 'Apagar o instantâneo',
        confirm: 'Apagar este instantâneo? Não dá para recuperá-lo.',
      },
      revert: { label: 'Mostrar como vermelho' },
    },
    cost: {
      title: 'Custo',
      last24: 'Últimas 24 horas',
      last7: 'Últimos 7 dias',
      allTime: 'Desde o início',
      perTask: (tasks: number) => `Por tarefa (${tasks})`,
      agent: 'Agente',
      role: 'Papel',
      runs: 'Execuções',
      cost: 'Custo',
      averageTime: 'Tempo médio',
      failed: 'Falharam',
      quota: 'Sem cota',
      notReported: 'não informado',
      partlyReported: (reported: number, runs: number) => `(${reported} de ${runs} informados)`,
      none: 'Nenhum agente rodou ainda.',
    },
  },
  watch: {
    title: 'Branch padrão depois da versão final',
    label: 'Branch padrão',
    status: {
      watching: 'acompanhando as verificações da branch padrão',
      reverting: 'a branch padrão ficou vermelha, abrindo uma reversão',
      green: 'a branch padrão continuou verde',
      red: 'a branch padrão ficou vermelha',
      silent: 'sem veredito: as verificações nunca responderam',
    },
    release: 'versão final',
    merge: 'merge',
    revert: 'Pull request de reversão',
    noRevert: 'Não foi possível abrir um pull request de reversão.',
    dealtWith: 'resolvido',
    handled: 'Já resolvi',
  },
  recipe: {
    reading: 'Lendo .factory/setup.json…',
    unusable: 'Não dá para usar a receita',
    label: 'Receita',
    none: 'Não há .factory/setup.json na branch padrão, então uma execução usa só as configurações acima.',
    from: 'De .factory/setup.json na branch padrão',
    install: 'Instalação:',
    checks: 'Verificações, quando nenhuma foi definida acima:',
    waits: 'espera por você',
    open: 'aberto',
    alsoReach: (domains: string) => `A próxima execução também acessaria ${domains}.`,
    approve: (count: number) =>
      `Aprovar ${count === 1 ? 'este domínio' : `estes ${count} domínios`}`,
  },
  knowledge: {
    label: 'Base de conhecimento',
    about: (branch: string) =>
      `Um repositório seu que todos os agentes consultam, no sandbox e no painel. As regras ficam em knowledge/ e só mudam por pull request seu. A fábrica busca o repositório a cada minuto e grava as próprias notas na branch ${branch}, nunca na sua.`,
    repository: 'Repositório',
    repositoryLabel: 'Repositório da base de conhecimento',
    none: 'Nenhum',
    rulesBranch: 'Branch das regras',
    defaultBranch: 'a padrão',
    save: 'Salvar',
    checking: 'Conferindo…',
    rules: 'Regras',
    notes: 'Notas',
    defaultBranchName: 'branch padrão',
    notesCount: (written: number, pending: number) => `${written} gravadas, ${pending} esperando`,
    lastFetch: 'Última busca',
    never: 'ainda não',
    failed: 'Falhou',
    failure: (error: string, when: string) =>
      `${error} (${when}). Os agentes seguem lendo o último commit bom.`,
    notOkf:
      'Os agentes já leem este repositório, mas ele não segue o Open Knowledge Format em tudo. A fábrica pode abrir um pull request que acrescenta o que falta, sem mudar nenhum texto que já existe.',
    propose: 'Propor a estrutura',
    opened: 'Pull request aberto:',
    afterMerge: 'Depois do merge, a fábrica lê a estrutura nova em até um minuto.',
  },
  account: {
    tryAgain: 'Tentar de novo',
    cancel: 'Cancelar',
    checking: (limit: string) =>
      `Conferindo a conta com uma chamada de teste. Pode levar até ${limit}.`,
    oneMinute: 'um minuto',
    twoMinutes: 'dois minutos',
    signInOther: 'Entrar com outra conta',
    claude: {
      label: 'Trocar a conta do Claude Code',
      idle: 'A conta do Claude Code estourou o limite, ou você quer usar outra? Entre com a outra conta aqui.',
      step1:
        'Abra a página de login e entre na conta que quer usar. Se o navegador já estiver numa conta, saia dela antes ou use uma janela anônima.',
      openLogin: 'Abrir a página de login',
      step2: 'A página vai mostrar um código. Copie e cole aqui:',
      codeLabel: 'Código da página de login',
      codePlaceholder: 'Cole o código inteiro, com o #',
      connect: 'Conectar',
      done: 'Pronto: a fábrica já usa a conta nova, sem reiniciar nada. Testei com uma chamada e ela respondeu.',
    },
    codex: {
      label: 'Trocar a conta do Codex',
      connected: (email: string | undefined, plan: string | undefined) =>
        `Conectado${email ? ` como ${email}` : ''}${plan ? ` (plano ${plan})` : ''}. A conta estourou o limite, ou você quer usar outra? Entre com a outra conta aqui.`,
      unusable: (problem: string) =>
        `O login do Codex que está aqui não pode ser usado: ${problem}`,
      noAccount: 'O Codex ainda não tem uma conta do ChatGPT. Entre com ela aqui.',
      connect: 'Conectar o Codex',
      open: 'Abra',
      thenType: 'na conta do ChatGPT que quer usar e digite o código',
      waitHint:
        'Se o navegador já estiver em outra conta, saia dela antes ou use uma janela anônima. Esta página percebe sozinha quando você terminar.',
      done: (email: string | undefined) =>
        `Pronto: a fábrica já usa a conta nova${email ? ` (${email})` : ''}, sem reiniciar nada. Testei com uma chamada e ela respondeu.`,
    },
  },
  composer: {
    moreActions: 'Mais ações',
    message: 'Mensagem',
    stop: 'Parar',
    send: 'Enviar',
    placeholder: 'Pergunte',
    startIssue: { label: 'Abrir uma issue', text: 'Quero abrir uma issue para ' },
    startPlan: { label: 'Planejar um objetivo', text: 'Quero planejar este objetivo: ' },
    startStuck: { label: 'Ver o que travou', text: 'Quais tarefas travaram e por quê?' },
  },
  chatgpt: {
    label: 'Conectar o ChatGPT',
    intro: 'Conecte a sua assinatura do ChatGPT para conversar com este modelo.',
    open: 'Abra',
    typeCode: 'e digite o código',
    waitHint: 'Esta página percebe sozinha quando você terminar.',
    connect: 'Conectar o ChatGPT',
    failed: 'Não deu certo:',
  },
  chat: {
    notFound: 'Não encontrei essa conversa.',
    loading: 'Carregando…',
    ready: 'Pronto quando você quiser.',
    askFactory: 'Pergunte à fábrica',
  },
  guide: {
    close: 'Fechar o guia',
    subtitle: 'Explica e ajusta esta página',
    hint: 'Pergunte o que quiser sobre esta página. Eu só mudo algo depois do seu OK.',
    understand: 'Entender',
    act: 'Fazer',
    placeholder: 'Pergunte ao guia',
  },
  planSection: {
    title: 'Plano',
    none: 'Nenhum plano foi escrito para esta tarefa.',
    by: (harness: string, sha: string) => `por ${harness} sobre ${sha}`,
    latestOf: (n: number) => ` · o último de ${n}`,
    files: 'Arquivos',
    noFile: 'Nenhum arquivo: o construtor esperava que o código já fizesse o que a issue pede.',
    order: 'Ordem',
    risks: 'Riscos',
    proof: 'Prova',
    outOfScope: 'Fora do escopo',
  },
  agents: {
    metaTitle: 'Agentes · aifactory',
    metaDescription: 'Os agentes da fábrica e os prompts de cada um.',
    heading: 'Agentes',
    intro:
      'Quem trabalha na fábrica, o que cada um recebe de instrução e o que pode fazer. As instruções são só para ler; o agente de código de cada papel dá para trocar aqui.',
    searchLabel: 'Buscar agente ou texto de uma instrução',
    loadError: 'Não consegui carregar os agentes',
    loading: 'Carregando…',
    none: (query: string) => `Nenhum agente tem “${query}” no nome nem nas instruções.`,
    runsInSandbox: 'Roda no sandbox',
    runsOnServer: 'Roda no servidor',
    when: 'Quando entra em ação',
    engine: 'Modelo ou agente',
    howToChange: (change: string) => `Como mudar: ${change}`,
    canDo: 'O que pode fazer',
    effects: {
      reads: 'só lê',
      asks: 'muda algo, pede seu OK',
      sandbox: 'age só dentro do sandbox',
    },
    instructions: 'Instruções',
    instructionsOf: 'Instruções do agente',
    alsoReceives: 'Também recebe:',
    whereInCode: 'Onde está no código',
    readOnly: 'As instruções só se leem aqui: para mudar uma, o texto está nesses arquivos.',
  },
  coordinator: {
    heading: 'Coordenador',
    sectionTitle: 'O que o coordenador decidiu',
    intro: 'Cada decisão do coordenador, da mais nova para a mais antiga.',
    openList: 'Todas as decisões do coordenador',
    back: 'Voltar para a caixa de entrada',
    filter: 'Resultado',
    all: 'Todos',
    empty: 'O coordenador ainda não decidiu nada.',
    loadMore: 'Mostrar decisões mais antigas',
    reasonLabel: 'Motivo',
    draftLabel: 'Texto redigido',
    escalatedBy: (reason: string) => `O coordenador encaminhou para uma pessoa: ${reason}`,
    outcomes: {
      applied: 'Aplicada',
      trial: 'Teste',
      refused: 'Recusada',
      failed: 'Falhou',
      escalated: 'Encaminhada',
      deferred: 'Ler de novo depois',
    } as Record<string, string>,
    actions: {
      send_back: 'Devolver',
      review_again: 'Revisar de novo',
      retry_from_finding: 'Tentar de novo a partir de um achado',
      scope: 'Delimitar uma continuação',
      release: 'Publicar',
      prioritise: 'Passar à frente na fila',
      fix_base: 'Abrir a correção da branch de integração',
      merge_base: 'Fazer merge da branch de integração',
      wait: 'Ler de novo nas próximas passadas',
      escalate: 'Encaminhar',
    } as Record<string, string>,
    exceptions: {
      checks_unchanged: 'Os checks não mudaram',
      review_plateau: 'A revisão não avançou',
      review_unusable: 'Revisão inutilizável',
      handoff: 'Entregue a uma pessoa',
      stalled: 'Parada',
      orphaned: 'Órfã',
      environment: 'Problema de ambiente',
      failure: 'Falha',
      checks_red: 'Checks ainda falhando',
      out_of_time: 'Sem tempo',
      no_change: 'Nenhuma mudança feita',
      unknown: 'Desconhecida',
      release_ready: 'Pronta para publicar',
      release_retry: 'Publicação a repetir',
      release_blocked: 'Publicação bloqueada',
      base_red: 'Branch de integração quebrada',
      base_conflict: 'Merge da branch de integração com conflito',
      queue_blocked: 'Correção esperando na fila',
    } as Record<string, string>,
  },
  inbox: {
    heading: 'Caixa de entrada',
    nothing: 'Nada espera por você.',
    question: 'Responder a uma pergunta',
    review: 'Revisar o pull request',
    handoff: 'Precisa de uma pessoa',
    failed: 'Falhou',
    main_red: 'A branch padrão está vermelha',
  },
  plans: {
    heading: 'Planos',
    enableFirst: 'Ative um repositório primeiro',
    enableFirstText:
      'Um plano é escrito para um repositório, e a fábrica só trabalha nos que você ativa.',
    openRepositories: 'Abrir Repositórios',
    newPlan: 'Novo plano',
    whatBuilt: 'O que você quer construir?',
    repository: 'Repositório',
    goal: 'Objetivo',
    goalPlaceholder:
      'Descreva o resultado, por exemplo: acrescentar uma linha de comando com uma tela de ajuda e uma opção de versão.',
    make: 'Fazer um plano',
    earlier: 'Planos anteriores',
    none: 'Nenhum plano ainda.',
    status: {
      planning: 'planejando',
      ready: 'pronto para revisar',
      failed: 'falhou',
      created: 'issues criadas',
    },
    back: '← Planos',
    loading: 'Carregando…',
    reading: 'Um agente está lendo o repositório',
    readingText: 'Isso leva um ou dois minutos. A página se atualiza sozinha.',
    failedTitle: 'O plano não saiu',
    noReason: 'Nenhum motivo foi registrado.',
    tryAgain: 'Tentar de novo',
    issues: 'Issues',
    include: (n: number) => `Incluir a issue ${n}`,
    titleOf: (n: number) => `Título da issue ${n}`,
    moveUp: (n: number) => `Subir a issue ${n}`,
    moveDown: (n: number) => `Descer a issue ${n}`,
    removeLabel: (n: number) => `Tirar a issue ${n}`,
    remove: 'Tirar',
    descriptionOf: (n: number) => `Descrição da issue ${n}`,
    issueLink: (n: number) => `Issue #${n}`,
    started: 'iniciada',
    startThis: 'Iniciar esta',
    startedIssue: (n: number) => `Issue #${n} iniciada.`,
    saveChanges: 'Salvar alterações',
    saved: 'Salvo.',
    createIssues: 'Criar as issues',
    createAndStart: 'Criar as issues e iniciar',
    toCreate: (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'} para criar`,
    refused: (n: number, failure: string) => `Criei ${n}, e então o GitHub recusou: ${failure}`,
    created: (n: number, start: boolean) =>
      `${n} ${n === 1 ? 'issue criada' : 'issues criadas'}${start ? ' e iniciadas' : ''}.`,
  },
}
