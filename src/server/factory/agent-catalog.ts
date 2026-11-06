import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { GUIDE_IDS, GUIDE_NAMES, type GuideId } from '../../shared/guides'
import type { AgentEntry, AgentPrompt, AgentRole, AgentsView, AgentTool } from '../../shared/panel'
import { ASSIST_INSTRUCTIONS, SETUP_INSTRUCTIONS } from '../agents/prompts/assist'
import { proposeTool } from '../agents/tools/propose'
import { repoFileTool, repoTreeTool } from '../agents/tools/repo'

import type { AssistantSpec } from './assistant'
import { CHAT_SPEC } from './chat-agent'
import { optionsFor } from './engine-models'
import { DEFAULT_HARNESS } from './harness-registry'
import { buildPrompt } from './harness'
import { guideCodexModel, guideModel, guideSpec } from './guides'
import { assistModel, chatCodexModel, chatModel } from './models'
import { planPrompt } from './plan'
import { reviewPrompt, reworkPrompt } from './review'
import { answerPrompt } from './waiting'

/** The marks that stand where a task's own data goes in a prompt written as a template. */
const REPO = '‹repositório›'
const TITLE = '‹título da issue›'
const BODY = '‹texto da issue›'
const BRANCH = '‹branch›'

/** The prompt functions write the issue number as "#7"; the template shows where it goes. */
const numbered = (text: string) => text.replaceAll('#0)', '#‹número›)')

const template = (id: string, title: string, when: string, text: string): AgentPrompt => ({
  id,
  title,
  when,
  text: numbered(text),
  template: true,
})

const fixed = (id: string, title: string, when: string, text: string): AgentPrompt => ({
  id,
  title,
  when,
  text,
  template: false,
})

/** What an agent may call, as the model is told it. A tool the owner must approve says so. */
function toolsOf(spec: Pick<AssistantSpec, 'tools' | 'asks'>): AgentTool[] {
  return Object.entries(spec.tools).map(([name, tool]) => ({
    name,
    description: (tool as { description?: string }).description ?? '',
    effect: name in spec.asks ? 'asks' : 'reads',
  }))
}

const SANDBOX_TOOL: AgentTool = {
  name: 'sandbox',
  description:
    'Roda comandos e edita arquivos só dentro do sandbox, que alcança apenas o GitHub, o próprio agente, o registro npm e os domínios que você liberou no repositório. Não faz commit nem push: quem faz é a fábrica.',
  effect: 'sandbox',
}

/** The agent of a role with the model and the effort it is told to use, or "default" where nothing is set. */
function engineValue(env: NodeJS.ProcessEnv, role: AgentRole, engine: string): string {
  const { model, effort } = optionsFor(env, role, engine)
  return `${engine} · ${model ?? 'modelo padrão'}${effort ? ` · esforço ${effort}` : ''}`
}

/** The agents that build, review and plan. They run in a sandbox the factory makes for each run. */
function factoryAgents(env: NodeJS.ProcessEnv): AgentEntry[] {
  const builder = env.FACTORY_HARNESS || DEFAULT_HARNESS
  const choose =
    'Aqui mesmo, na página Agentes, vale para as próximas execuções sem reiniciar. A configuração de um repositório ou a label harness:<nome> numa issue mudam para uma só.'
  const issue = { repo: REPO, issueNumber: 0, title: TITLE, body: BODY, branch: BRANCH }
  return [
    {
      id: 'builder',
      group: 'factory',
      name: 'Construtor',
      role: 'Escreve o código de uma issue num sandbox isolado, roda os testes do projeto e entrega o resultado, que a fábrica confere e envia.',
      runsIn: 'sandbox',
      engine: { value: engineValue(env, 'builder', builder), change: choose },
      when: 'Quando uma issue com a label factory vira tarefa. Volta a ele quando os checks ou o revisor pedem mudanças, quando você responde a uma pergunta dele e quando você pede mudanças num PR.',
      tools: [SANDBOX_TOOL],
      shared: [],
      source: [
        'src/server/factory/harness.ts',
        'src/server/factory/review.ts',
        'src/server/factory/waiting.ts',
      ],
      prompts: [
        template(
          'build',
          'Primeira tentativa',
          'No começo de toda tarefa, quando o agente pode perguntar.',
          buildPrompt(issue),
        ),
        template(
          'build-silent',
          'Quando ninguém está lá para responder',
          'No lugar da instrução de perguntar, em repositórios configurados para o agente decidir sozinho.',
          buildPrompt({ ...issue, askQuestions: false }),
        ),
        template(
          'build-feedback',
          'Quando você pede mudanças num PR',
          'Parte do trabalho anterior do agente, com o seu pedido no texto.',
          buildPrompt({ ...issue, feedback: '‹o pedido da pessoa›' }),
        ),
        template(
          'rework',
          'Retrabalho depois dos checks ou do revisor',
          'Quando um check falha ou o revisor pede mudanças. O agente volta à mesma sessão, até 3 tentativas.',
          reworkPrompt({
            failedChecks: [{ command: '‹comando do check›', output: '‹fim da saída›' }],
            findings: [
              { severity: 'major', file: '‹arquivo›', issue: '‹o que está errado e o que fazer›' },
            ],
          }),
        ),
        template(
          'answer',
          'Depois de uma resposta sua',
          'Quando o agente perguntou algo na issue e uma pessoa com permissão respondeu.',
          answerPrompt('‹a pergunta›', '‹a resposta›', '‹quem respondeu›'),
        ),
      ],
    },
    {
      id: 'reviewer',
      group: 'factory',
      name: 'Revisor',
      role: 'Lê a mudança do construtor como alguém de fora e decide entre aprovar e pedir mudanças. Não edita nada.',
      runsIn: 'sandbox',
      engine: {
        value: `${engineValue(env, 'reviewer', env.FACTORY_REVIEWER || builder)}${env.FACTORY_REVIEWER ? '' : ' (o mesmo agente do construtor, numa sessão nova)'}`,
        change:
          'Aqui mesmo, na página Agentes, ou a label reviewer:<nome> numa issue. Um agente diferente do construtor dá uma segunda opinião de verdade.',
      },
      when: 'Depois que os checks passam num commit, e de novo a cada retrabalho. Até 3 revisões por tarefa.',
      tools: [
        {
          ...SANDBOX_TOOL,
          description:
            'Pode ler o código e rodar os testes do projeto. O prompt proíbe editar, criar ou apagar arquivos e rodar git que escreve.',
        },
      ],
      shared: [],
      source: ['src/server/factory/review.ts'],
      prompts: [
        template(
          'review',
          'Instruções da revisão',
          'Toda vez que o revisor entra, com o diff entre o commit base e o commit do construtor.',
          reviewPrompt({ ...issue, baseSha: '‹commit base›' }),
        ),
      ],
    },
    {
      id: 'planner',
      group: 'factory',
      name: 'Planejador',
      role: 'Lê o repositório e divide um objetivo seu em issues pequenas e independentes, para você revisar. Não altera nada.',
      runsIn: 'sandbox',
      engine: {
        value: `${engineValue(env, 'planner', env.FACTORY_PLANNER || builder)}${env.FACTORY_PLANNER ? '' : ' (o mesmo agente do construtor)'}`,
        change: 'Aqui mesmo, na página Agentes. Sem escolha, usa o agente do Construtor.',
      },
      when: 'Quando você cria um plano na página Planos. Termina com um JSON que a fábrica transforma na lista de issues.',
      tools: [SANDBOX_TOOL],
      shared: [],
      source: ['src/server/factory/plan.ts'],
      prompts: [
        template(
          'plan',
          'Instruções do plano',
          'Uma vez por plano, com o objetivo que você escreveu.',
          planPrompt({ repo: REPO, goal: '‹o objetivo que você escreveu›' }),
        ),
      ],
    },
  ]
}

const PANEL_WHERE =
  'Roda no servidor da fábrica, onde estão as credenciais, por isso só pode chamar as ferramentas listadas aqui.'

/** The assistants of the panel: the chat, one guide for each page, and the two that help with text. */
function panelAgents(env: NodeJS.ProcessEnv): AgentEntry[] {
  const chat: AgentEntry = {
    id: 'chat',
    group: 'panel',
    name: 'Assistente do chat',
    role: 'Conversa com você sobre a fábrica, lê o estado dela e, com a sua aprovação, repete tarefas, devolve trabalho e abre issues.',
    runsIn: 'server',
    engine: {
      value: `${chatModel(env)} (OpenRouter) ou ${chatCodexModel(env)} (ChatGPT)`,
      change:
        'O seletor do campo de mensagem escolhe entre os dois. O modelo de cada um é FACTORY_CHAT_MODEL e FACTORY_CHAT_CODEX_MODEL, no arquivo de ambiente: só vale depois de reiniciar o painel, porque o framework fixa o modelo dos agentes do painel quando o servidor sobe.',
    },
    when: `Na tela inicial. ${PANEL_WHERE}`,
    tools: toolsOf(CHAT_SPEC),
    shared: ['theo'],
    source: [
      'src/server/agents/prompts/chat.ts',
      'src/server/factory/chat-agent.ts',
      'src/server/agents/tools/chat.ts',
    ],
    prompts: [fixed('system', 'Instruções do sistema', 'Em toda conversa.', CHAT_SPEC.system)],
  }
  const guides = GUIDE_IDS.map((id: GuideId): AgentEntry => {
    const spec = guideSpec(id)
    return {
      id: `guide-${id}`,
      group: 'panel',
      name: GUIDE_NAMES[id],
      role: 'Especialista de uma página do menu: explica a página, responde sobre os dados dela e, com a sua aprovação, muda o que a página permite mudar.',
      runsIn: 'server',
      engine: {
        value: `${guideModel(env)} (OpenRouter) ou ${guideCodexModel(env)} (ChatGPT)`,
        change:
          'FACTORY_GUIDE_MODEL (cai em FACTORY_CHAT_MODEL) e FACTORY_CHAT_CODEX_MODEL, no arquivo de ambiente: só valem depois de reiniciar o painel, porque o framework fixa o modelo dos agentes do painel quando o servidor sobe.',
      },
      when: `No painel ao lado da página, pelo botão Guia. ${PANEL_WHERE}`,
      tools: toolsOf(spec),
      shared: ['theo'],
      source: [
        'src/server/agents/prompts/guides.ts',
        'src/server/factory/guides.ts',
        'src/server/agents/tools/guide.ts',
      ],
      prompts: [
        fixed(
          'system',
          'Instruções do guia',
          'Em toda conversa com o guia: as regras de comunicação de todos os guias, seguidas do manual desta página.',
          spec.system,
        ),
      ],
    }
  })
  const assist: AgentEntry = {
    id: 'assist',
    group: 'panel',
    name: 'Assistente de texto',
    role: 'Transforma o que você escreve com as suas palavras num objetivo, numa issue ou num pedido de mudanças que a fábrica entende.',
    runsIn: 'server',
    engine: {
      value: assistModel(env),
      change:
        'FACTORY_ASSIST_MODEL, no arquivo de ambiente, com a chave do provedor do modelo. Só vale depois de reiniciar o painel, porque o framework fixa o modelo dos agentes do painel quando o servidor sobe.',
    },
    when: `Embaixo de cada caixa de texto do painel. Propõe um texto e nada muda até você apertar "Use this". ${PANEL_WHERE}`,
    tools: [{ name: 'propose', description: proposeTool.description, effect: 'reads' }],
    shared: ['theo'],
    source: ['src/server/agents/assist.ts', 'src/server/agents/prompts/assist.ts'],
    prompts: [
      fixed(
        'system',
        'Instruções do sistema',
        'Em toda chamada, com o tipo de texto no começo da mensagem.',
        ASSIST_INSTRUCTIONS,
      ),
    ],
  }
  const setup: AgentEntry = {
    id: 'assist-setup',
    group: 'panel',
    name: 'Assistente de configuração de repositório',
    role: 'Lê os arquivos que dizem como um projeto é construído e testado e propõe os checks e os domínios extras do repositório.',
    runsIn: 'server',
    engine: {
      value: assistModel(env),
      change:
        'FACTORY_ASSIST_MODEL, no arquivo de ambiente, com a chave do provedor do modelo. Só vale depois de reiniciar o painel, porque o framework fixa o modelo dos agentes do painel quando o servidor sobe.',
    },
    when: `No botão "Set this up for me", na página Repositórios. É o único que pode ler um repositório, e só os arquivos de build e de teste. ${PANEL_WHERE}`,
    tools: [proposeTool, repoTreeTool, repoFileTool].map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      effect: 'reads',
    })),
    shared: ['theo'],
    source: ['src/server/agents/assist-setup.ts', 'src/server/agents/prompts/assist.ts'],
    prompts: [fixed('system', 'Instruções do sistema', 'Em toda chamada.', SETUP_INSTRUCTIONS)],
  }
  return [chat, ...guides, assist, setup]
}

/** The text the framework adds to what every panel agent is given, read from the one file it lives in. */
function sharedContext(read: (path: string) => string): AgentPrompt[] {
  try {
    return [
      fixed(
        'theo',
        'Contexto da fábrica',
        'Junto de toda mensagem de todos os agentes do painel. Diz o que é a fábrica e o que faz um bom pedido.',
        read('.theokit/THEO.md'),
      ),
    ]
  } catch {
    return []
  }
}

/**
 * Every agent of the factory with what it is told and what it may do, built from the code that runs them:
 * the prompts are the ones the functions return, the tools are the ones declared, the models are the ones
 * configured now. Nothing here is a copy that could fall behind.
 */
export function agentCatalog(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(resolve(process.cwd(), path), 'utf8'),
): Omit<AgentsView, 'settings'> {
  return { agents: [...factoryAgents(env), ...panelAgents(env)], shared: sharedContext(read) }
}
