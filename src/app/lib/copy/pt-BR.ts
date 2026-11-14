import type { DoctorTriedSentences } from '../../../shared/doctor-say'

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
  token: (v) => `gerar um token para ${v.repo}`,
  merge_settings: (v) => `ler as configurações de merge de ${v.repo}`,
}

/** What was tried, in Portuguese when the code is one this panel knows, and as the server said it otherwise. */
const tried = (v: Record<string, string>) => TRIED[v.what as keyof typeof TRIED]?.(v) ?? v.tried

/** Why a recipe cannot be used, by kind. */
const RECIPE_WHY: Record<string, (detail: string) => string> = {
  not_json: (d) => `ele não é JSON (${d})`,
  invalid: (d) => d,
  status: (d) => `o GitHub respondeu ${d} ao lê-lo`,
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
    attempt: (n: number) => `tentativa ${n} de 3`,
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
    pr: 'abrindo o pull request',
    done: 'pull request aberto',
    released: 'publicada',
    handoff: 'passada para uma pessoa',
    failed: 'falhou',
    cancelled: 'cancelada',
    alreadyResolved: 'já resolvida',
    integrated: 'integrada',
    waitingForChecks: 'esperando a CI',
    waitingForLimit: 'esperando o limite',
    willRetry: 'vai tentar de novo',
    waitingForIssue: 'esperando outra issue',
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
    say: {
      unknown: {
        cause: (v) =>
          `Não sei: ${tried(v)} falhou (${v.error}). Nada é dado como certo sem ter sido lido.`,
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
          `${v.integration} exige checks, então a fábrica espera por eles com o auto-merge, e ${v.repo} está com ${v.off} desligado.`,
        repair: (v) => `Ligue ${v.turnOn} em Settings, General, Pull Requests.`,
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
            ? `${v.repo}: ${v.path} na branch padrão não pode ser usado: ${why(v.detail ?? '')}`
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
          `O provedor de sandbox recusou a última execução deste repositório (tarefa ${v.taskId}, ${v.at}): ${v.error}`,
        repair: () =>
          'Ponha crédito no provedor de sandbox, ou corrija a chave dele no servidor. A tarefa tenta de novo sozinha quando o provedor aceitar.',
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
}
