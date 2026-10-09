// Manual do app: o assistente ensina a usar qualquer parte do aplicativo.
// Cada tópico tem palavras-chave (sem acento, minúsculas) com peso, e um texto curto em passos.
// Mantenha os nomes de botões e telas IGUAIS aos do app.

import { fold } from "./naming.ts";

export interface Topic { id: string; titulo: string; chaves: Record<string, number>; texto: string }

export const TOPICS: Topic[] = [
  {
    id: "instalar", titulo: "Instalar o app no celular",
    chaves: { instal: 3, "tela inicial": 3, "tela de inicio": 3, atalho: 2, icone: 1, "baixar o app": 3, "baixar": 1, "play store": 3, "app store": 3, pwa: 2 },
    texto: `📱 *Instalar o app no celular* (não precisa de loja de aplicativos):
• *Android (Chrome)*: abra o app no Chrome → menu ⋮ (canto de cima) → *Instalar app* (ou *Adicionar à tela inicial*).
• *iPhone (Safari)*: abra o app no Safari → botão Compartilhar (quadrado com seta) → *Adicionar à Tela de Início*.
Também tem um botão *Instalar agora* em *Configurações → Instalar no celular*, quando o aparelho permite.
Depois disso o app abre pelo ícone, em tela cheia, como um aplicativo normal.`,
  },
  {
    id: "atualizar", titulo: "Atualizar o app / novidades não aparecem",
    chaves: { atualiz: 3, "versao nova": 3, novidade: 2, "nao apareceu": 2, "nao aparece": 1, "continua igual": 3, "visual antigo": 3, recarreg: 2, cache: 2 },
    texto: `🔄 *Atualizar o app*
O app se atualiza sozinho, mas a versão nova só entra quando ele é aberto de novo:
1. Feche o app por completo (tire ele da lista de apps abertos).
2. Abra de novo. Se ainda aparecer a versão antiga, feche e abra mais uma vez.
No computador, basta recarregar a página (F5).
O ícone na tela inicial pode demorar a mudar; se não mudar, remova o atalho e adicione de novo.`,
  },
  {
    id: "microfone", titulo: "Áudio e permissão do microfone",
    chaves: { microfone: 4, permiss: 3, "mandar audio": 3, "enviar audio": 3, "gravar": 2, audio: 2, voz: 2, falar: 1, "fica pedindo": 3, "pede toda vez": 3, "ouvir o audio": 3, "ouvir de novo": 3 },
    texto: `🎙️ *Áudio no app*
• Na aba *Assistente*, toque no microfone, fale o gasto ou a pergunta e toque em *enviar* (ou no X para cancelar). Até 2 minutos.
• Eu mostro o que entendi do áudio. Se o valor ficar duvidoso, eu pergunto antes de lançar.
• Os áudios ficam guardados por 7 dias: toque em *Ouvir áudio* na mensagem para conferir.
*Se o celular fica pedindo permissão do microfone:*
• *Android (Chrome)*: quando aparecer a pergunta, escolha *Permitir* (não "Só desta vez"). Se bloqueou sem querer: toque no cadeado ao lado do endereço → Permissões → Microfone → Permitir.
• *iPhone*: Ajustes → Apps → Safari → Microfone → *Permitir*. Com o app instalado na tela inicial, o iPhone ainda pode perguntar uma vez a cada vez que o app é aberto — isso é regra do iPhone, não dá para mudar pelo app.
• Dentro de uma mesma abertura do app, a permissão vale para vários áudios seguidos.
Também dá para mandar áudio pelo Telegram.`,
  },
  {
    id: "telegram", titulo: "Conectar o Telegram",
    chaves: { telegram: 4, robo: 2, bot: 2, "conectar": 1, vincul: 2, "codigo de conexao": 3, "/start": 3 },
    texto: `✈️ *Usar pelo Telegram*
1. No app, vá em *Configurações → Conectar WhatsApp e Telegram* e toque em *Gerar código de conexão*.
2. Toque em *Abrir Telegram* (ou abra o robô do app no Telegram e envie a mensagem com o código que aparece, ex.: /start ABC123). O código vale por alguns minutos.
3. Pronto: mande textos, áudios, fotos ou o PDF da fatura para o robô, como faria aqui.
• Cada pessoa da família conecta o *próprio* Telegram, entrando com a própria conta no app.
• Para desligar: *Configurações → Desconectar* (ao lado do Telegram).`,
  },
  {
    id: "whatsapp", titulo: "WhatsApp",
    chaves: { whatsapp: 4, zap: 3, wpp: 3 },
    texto: `💬 *WhatsApp*
A conexão pelo WhatsApp ainda está sendo preparada. Por enquanto use o próprio app (texto ou áudio) ou o Telegram — eles fazem exatamente as mesmas coisas. Quando o WhatsApp estiver pronto, a conexão será igual à do Telegram: *Configurações → Gerar código de conexão*.`,
  },
  {
    id: "familia", titulo: "Modo família (convidar e ver por pessoa)",
    chaves: { familia: 3, convid: 3, esposa: 2, marido: 2, "adicionar pessoa": 3, "entrar na familia": 4, membro: 2, compartilhad: 2, "cada um": 1, "remover pessoa": 3 },
    texto: `👨‍👩‍👧 *Família*
*Convidar alguém:*
1. Quem é o titular vai em *Configurações → Família → Convidar pessoa* e passa o código para a outra pessoa.
2. A outra pessoa cria a conta dela no app e, em *Configurações → Família → Recebi um convite*, digita o código e toca em *Entrar na família* (precisa ser uma conta nova, ainda sem lançamentos).
*No dia a dia:*
• No início e nos lançamentos há o filtro *Todos / cada pessoa / Compartilhado*: cada um vê só os próprios valores, ou tudo junto.
• Ao lançar, escolha *De quem é?* (meu, da outra pessoa ou Família). Pelo chat: “gastamos 300 no mercado” vira compartilhado.
• Contas bancárias e cartões também têm dono (*De quem é a conta/cartão?*).
• O titular pode *Remover* alguém; quem é membro pode *Sair*.`,
  },
  {
    id: "lancar", titulo: "Registrar gastos e receitas",
    chaves: { lanc: 2, registr: 2, "anotar": 2, "colocar um gasto": 3, "adicionar gasto": 3, "nova despesa": 3, "nova receita": 3, "botao +": 3, "botao mais": 3, parcel: 2, "varios de uma vez": 3, "data diferente": 2, "outro dia": 1 },
    texto: `💸 *Registrar gastos e receitas* — três jeitos:
1. *Conversando* (aqui, no Telegram ou por áudio): “gastei 87,50 no mercado”, “recebi 3 mil de salário”, “paguei 200 de gasolina ontem”.
   • Vários de uma vez: “gastei 20 na padaria e 50 de gasolina”.
   • Parcelado: “comprei uma TV de 2.400 em 10x no Nubank”.
   • Outra data: “ontem”, “dia 5”, “sexta”.
2. *Botão +* (no Início ou em Lançamentos): escolha Despesa, Receita, Conta a pagar, A receber ou Transferência e preencha. Os valores já aparecem em reais enquanto você digita, e as *parcelas* são escolhidas numa lista (mostra o valor de cada uma).
3. *Importando* extrato ou fatura (pergunte “como importo a fatura?”).
Eu escolho a categoria sozinho e vou aprendendo com as suas correções.`,
  },
  {
    id: "historico", titulo: "Repetir um lançamento (histórico ao digitar)",
    chaves: { "historico": 2, "repetir": 3, "igual ao anterior": 3, "copiar": 3, "ultimos lancamentos": 2, "sugest": 2, "forma de pagamento": 3, pix: 2, debito: 1, dinheiro: 1, boleto: 1 },
    texto: `🕘 *Repetir um lançamento parecido*
No formulário do *+*, comece a digitar a descrição (ex.: “merc”): aparecem os últimos lançamentos parecidos, com valor, categoria, conta ou cartão, forma de pagamento e data.
Toque em um deles para copiar tudo; o cursor vai para o valor, aí é só ajustar e *Salvar*.
O campo *Forma de pagamento* (Pix, Débito, Dinheiro, Boleto…) fica salvo e aparece nesse histórico.`,
  },
  {
    id: "editar", titulo: "Corrigir ou apagar um lançamento",
    chaves: { corrig: 3, editar: 3, alterar: 2, mudar: 1, apag: 3, exclu: 3, delet: 3, errado: 2, "lancei errado": 4, "categoria errada": 4, duplicad: 2 },
    texto: `✏️ *Corrigir ou apagar*
• *Pelo chat*: “muda a categoria para lazer”, “o valor certo é 45”, “apague o último lançamento”.
• *No app*: vá em *Lançamentos*, toque no lançamento, altere e toque em *Salvar* — ou em *Excluir*.
• Compras parceladas: a categoria e a descrição mudam em todas as parcelas; excluir apaga todas.
• Se eu registrar algo igual duas vezes em poucos minutos, eu pergunto antes.`,
  },
  {
    id: "apagar", titulo: "Contas a pagar e a receber (lembretes 👎/👍)",
    chaves: { "a pagar": 4, "a receber": 4, venciment: 3, lembret: 3, atrasad: 3, pendenc: 4, "joinha": 3, "polegar": 3, "marcar como pag": 4, "como paga": 4, "como pago": 3, "como recebid": 3, "ja paguei": 2, "conta futura": 3, "despesa futura": 3, "nao paguei": 2, "previsto": 2 },
    texto: `⏰ *Contas a pagar e a receber*
*Cadastrar:* botão *+* → *Conta a pagar* (ou *A receber*) → descrição, valor e *Vencimento*. Uma data futura já vira “a pagar” sozinha. No formulário, o campo *Situação* alterna entre *Pago* e *A pagar*.
*Lembrete no Início:* no alto aparece o botão de pendências (vermelho se houver algo em atraso; verde “Nada atrasado” se estiver tudo em dia). Toque em *Ver* para abrir a lista do que está *em atraso* e do que vence *nos próximos 7 dias*, cada um com um 👎 vermelho (= ainda não pago).
*Pagou?* Toque no 👎: ele vira 👍 verde, o valor sai do saldo e o item sai da lista. Pelo chat também funciona: “paguei a conta de luz” confirma a que estava pendente (sem lançar de novo).
• Conta a pagar não mexe no saldo até você confirmar.
• Contas fixas pagas por conta (aluguel, internet, salário) entram como pendentes todo mês; as do cartão são automáticas (entram na fatura).`,
  },
  {
    id: "fixas", titulo: "Contas fixas (todo mês)",
    chaves: { "conta fixa": 4, "contas fixas": 4, recorren: 4, "todo mes": 3, mensal: 2, assinatura: 2, "cancelar assinatura": 3, salario: 1, aluguel: 1, "quinto dia util": 3 },
    texto: `🔄 *Contas fixas* (aluguel, internet, assinaturas, salário…)
• *Pelo chat*: “minha internet custa 120 todo dia 10”, “recebo 7 mil todo quinto dia útil”, “a Netflix é 55 por mês no Nubank”.
• *No app*: menu *Contas fixas* → *Nova conta fixa*.
• Para parar: “não pago mais a Netflix”, ou abra a conta fixa e toque em *Encerrar*.
Todo mês o app lança sozinho. Se for paga por conta, ela aparece em *Pendências* para você confirmar com 👍; se for no cartão, já entra na fatura.`,
  },
  {
    id: "cartoes", titulo: "Cartões de crédito e faturas",
    chaves: { cartao: 3, cartoes: 3, fatura: 3, fechamento: 3, "limite": 2, "pagar a fatura": 4, "pagar fatura": 4, "integracao com o banco": 4, "banco do cartao": 3, credito: 1 },
    texto: `💳 *Cartões e faturas*
*Cadastrar:* menu *Cartões* → *Novo cartão* (nome, dia de fechamento, dia de vencimento, limite e de quem é). Pelo chat: “cadastre o cartão Nubank que fecha dia 3 e vence dia 10”.
*Compras:* “comprei 300 no Nubank”, “TV de 2.400 em 10x no Inter” — o app coloca cada parcela na fatura certa.
*Ver a fatura:* *Cartões → Ver fatura* (use as setas para outros meses). Pelo chat: “quanto está a fatura?”.
*Pagar:* *Cartões → Pagar fatura* (escolha a conta de onde saiu o dinheiro), ou diga “paguei a fatura do Nubank”.
O app *não* se conecta ao banco: ele organiza o que você lança ou importa (pergunte “como importo a fatura?”).`,
  },
  {
    id: "importar", titulo: "Importar fatura em PDF/foto ou extrato",
    chaves: { importar: 4, import: 3, pdf: 4, foto: 2, extrato: 3, ofx: 4, csv: 2, planilha: 2, upload: 3, "ler a fatura": 4, senha: 1 },
    texto: `📄 *Importar fatura ou extrato*
*Fatura do cartão (PDF ou foto):*
• No app: *Cartões → Importar fatura* → escolha o arquivo.
• No Telegram: mande o PDF ou a foto da fatura para o robô.
Eu leio as compras, sugiro as categorias e mostro uma *prévia*: confira, ajuste o que quiser e confirme. Compras que já estavam lançadas não duplicam.
*Extrato do banco:* *Contas → Importar extrato* (ou *Lançamentos → Importar*), arquivo OFX ou CSV do seu banco.
• PDF com senha não dá para ler: tire a senha (ou mande uma foto/print) e tente de novo.`,
  },
  {
    id: "dividir", titulo: "Dividir gastos e acertos entre a família",
    chaves: { divid: 4, metade: 3, rachar: 3, acerto: 4, "me deve": 3, "devo": 2, "quanto devo": 3, "paguei para": 2, "recebi da": 2 },
    texto: `🤝 *Dividir gastos e acertar*
• *Pelo chat*: “jantar de 150 no Nubank dividido com a Bruna” (cada um fica com 75; a outra pessoa fica devendo a parte dela), ou “250 no mercado, metade no meu cartão e metade no da Bruna”.
• *No app*: no *+*, em *De quem é?*, escolha *Dividir entre nós…* e informe a parte e o meio de pagamento de cada um.
• Quem deve para quem aparece no botão de pendências do Início (toque em *Ver* → *Acertos da família*). Quando acertarem, toque em *Paguei*/*Recebi* (informe data e forma) — ou *OK* para dispensar sem lançar nada.
• Pelo chat: “quanto devo?”, “acertei com a Bruna”.`,
  },
  {
    id: "contas", titulo: "Contas bancárias e saldo",
    chaves: { "conta bancaria": 4, "contas bancarias": 4, "nova conta": 3, "saldo inicial": 4, saldo: 2, carteira: 2, poupanca: 2, "arquivar conta": 3, transferenc: 2, banco: 1 },
    texto: `🏦 *Contas e saldo*
• Menu *Contas → Nova conta*: nome, tipo (corrente, digital, poupança, dinheiro…), *saldo inicial* (o saldo de hoje no banco) e de quem é.
• Pelo chat: “crie a conta Itaú com saldo de 2.300”.
• O saldo é calculado pelos lançamentos. Se não bater com o banco, ajuste o saldo inicial ou confira lançamentos faltando.
• Transferência entre contas: “transferi 500 do Nubank para a poupança” ou *+ → Transferência*.
• *Ajustar o saldo*: abra a conta → *Ajustar saldo* → informe o saldo que aparece no banco. A diferença entra como “Ajuste de saldo” (não conta como receita nem despesa).
• Conta que não usa mais: abra a conta → *Arquivar* (o histórico continua) ou *Excluir* (se tiver lançamentos, eu pergunto se apago junto).`,
  },
  {
    id: "categorias", titulo: "Categorias e subcategorias",
    chaves: { categori: 3, subcategori: 4, "criar categoria": 4, "nova categoria": 4, renomear: 2, emoji: 2, icone: 1 },
    texto: `🏷️ *Categorias*
• Menu *Categorias → Nova categoria* (nome e emoji). Em cada categoria: *+ subcategoria*, lápis para renomear, lixeira para excluir.
• Pelo chat: “crie a categoria Pets”, “crie a subcategoria Ração em Pets”.
• Se eu errar a categoria de um lançamento, corrija (“muda para lazer”): eu aprendo para as próximas vezes.`,
  },
  {
    id: "metas", titulo: "Metas (juntar dinheiro)",
    chaves: { meta: 3, metas: 3, juntar: 3, guardar: 2, objetivo: 2, viagem: 1, "reserva": 2 },
    texto: `🎯 *Metas*
• Pelo chat: “quero juntar 20 mil até dezembro para a viagem”, “guardei 500 na meta viagem”, “como estão minhas metas?”.
• No app: menu *Metas e planejamento*. Lá tem a sua média mensal (renda, gastos, sobra) e três grupos: *Reserva de emergência* (você escolhe quantos meses de gastos quer cobrir e eu calculo o valor), *Metas de poupança* e *Investimentos*. Em cada uma, informe quanto pretende guardar por mês para ver a previsão. Use *+ Guardar* e *− Retirar*; *Histórico* mostra os movimentos.
• Eu aviso quando estiver perto da meta ou se o ritmo não for suficiente para o prazo.`,
  },
  {
    id: "orcamentos", titulo: "Orçamentos por categoria",
    chaves: { orcament: 4, limite: 1, "gastar no maximo": 3, "teto": 2, estour: 3, "meta de economia": 3 },
    texto: `💵 *Orçamentos*
• Pelo chat: “orçamento de 1.000 para alimentação”, “como está meu orçamento?”.
• No app: menu *Orçamentos* → toque na categoria e defina o limite por mês.
• Eu aviso ao chegar em 80% e quando estourar.
• *Meta de economia do mês*: *Configurações → Perfil e meta*. Ela entra no cálculo de “quanto posso gastar”.`,
  },
  {
    id: "relatorios", titulo: "Relatórios e exportar (Excel, PDF, CSV)",
    chaves: { relatori: 4, exportar: 4, excel: 4, planilha: 2, imprimir: 3, pdf: 1, csv: 2, "comparar meses": 3, "ano todo": 2 },
    texto: `📊 *Relatórios*
• Menu *Relatórios*: escolha *Mês*, *Ano* ou *Período*. Mostra receitas, despesas por categoria e subcategoria, evolução, orçamento e metas.
• Botões *CSV*, *Excel* e *PDF* no topo baixam o relatório (o PDF abre a impressão: escolha “Salvar como PDF”).
• Em *Lançamentos* também tem *CSV* do mês.
• Pelo chat: “compare com o mês passado”, “qual minha maior despesa?”.`,
  },
  {
    id: "inicio", titulo: "Tela de Início (painéis)",
    chaves: { "tela inicial": 1, inicio: 2, painel: 3, paineis: 3, dashboard: 3, "saldo projetado": 4, "compromissos futuros": 4, "resultado do mes": 4, grafico: 2, kpi: 2 },
    texto: `🏠 *Início*
• *Botão de pendências* (no alto): mostra quantas contas estão atrasadas ou vencendo e os acertos da família; toque em *Ver* para abrir a lista com 👎/👍.
• Painéis: *Resultado do mês* (receitas − despesas), *Receitas*, *Despesas*, *Saldo em contas*, *Compromissos futuros* (contas a pagar e faturas até o fim do mês), *Faturas do mês* e *Saldo projetado* (estimativa para o fim do mês).
• *Toque em qualquer painel* para ver a lista do que compõe aquele valor.
• As setas no alto trocam o mês; o filtro de pessoas aparece no modo família.
• O botão *+* (canto de baixo) cria um lançamento.`,
  },
  {
    id: "nome", titulo: "Dar um nome ao assistente",
    chaves: { "nome do assistente": 4, "seu nome": 2, batiz: 3, apelido: 2, "te chamar": 3 },
    texto: `🏷️ *Nome do assistente*
• Diga “seu nome agora é Jarbas” (ou o nome que quiser), ou vá em *Configurações → Nome do assistente*.
• Depois é só chamar: “Jarbas, gastei 50 no mercado”, “quanto gastei hoje, Jarbas?”.
• Cada pessoa da família pode dar um nome diferente. Para tirar: “tira seu nome”.`,
  },
  {
    id: "cadastros_chat", titulo: "Cadastrar coisas conversando",
    chaves: { "pelo chat": 2, "pelo assistente": 2, "conversando": 3, "pedir para cadastrar": 4, "cadastrar pelo": 3 },
    texto: `🛠️ *Cadastros conversando*
Você pode pedir cadastros como pediria a uma pessoa — se faltar alguma informação, eu pergunto:
• “cadastre para a Bruna o cartão Nubank que vence dia 10”
• “crie a conta Itaú com saldo de 2.300”
• “mude o limite do Nubank para 8 mil”, “arquive o cartão Inter”
• “crie a categoria Pets”, “quero juntar 10 mil para a reserva até junho”
• “orçamento de 800 para lazer”, “quero economizar 1.500 por mês”`,
  },
  {
    id: "conta_login", titulo: "Login, senha e sair",
    chaves: { login: 3, senha: 3, "esqueci": 3, entrar: 1, "sair da conta": 4, deslog: 3, "trocar de conta": 3, email: 2, "outro celular": 3, "outro aparelho": 3 },
    texto: `🔐 *Conta e acesso*
• Entre com o mesmo e-mail e senha em qualquer celular ou computador: os dados são os mesmos em todos.
• Para sair: *Configurações → Conta → Sair*.
• Cada pessoa deve ter o próprio login (inclusive na família) — assim cada um vê os seus valores e o Telegram fica ligado à pessoa certa.
• Esqueceu a senha? Ainda não há botão de recuperação no app; fale com quem administra o app para redefinir.
• Nunca compartilhe sua senha por mensagem.`,
  },
  {
    id: "problemas", titulo: "Problemas: sem conexão, demora, erro",
    chaves: { "sem conexao": 4, conexao: 2, servidor: 3, demor: 3, lento: 3, erro: 2, travou: 3, "nao funciona": 3, "nao carrega": 3, "nao responde": 3, offline: 3, internet: 2, "nao entendeu": 2, "entendeu errado": 3 },
    texto: `🧰 *Se algo não funcionar*
• *“Sem conexão com o servidor”* ou demora: confira a internet e tente de novo em alguns segundos. Se continuar, feche e abra o app.
• *Áudio demorando*: áudios longos levam mais tempo; prefira mensagens curtas, um assunto por vez.
• *Entendi errado o que você disse*: corrija na hora (“não, foram 1.000”, “muda a categoria para lazer”) ou ouça o áudio de novo em *Ouvir áudio*.
• *Valores do início não batem*: confira o filtro de pessoa (Todos / cada um) e o mês selecionado.
• Novidades não apareceram? Feche e abra o app (veja “como atualizo o app?”).
Se o problema continuar, anote o que aconteceu e o horário e avise quem administra o app.`,
  },
  {
    id: "privacidade", titulo: "Privacidade e segurança",
    chaves: { privacid: 4, seguranc: 3, "meus dados": 3, "alguem ve": 3, "quem ve": 3, "dados seguros": 4, "seguro": 2 },
    texto: `🔒 *Privacidade*
• Cada família tem os dados separados: ninguém de fora vê seus lançamentos.
• No modo família, os membros veem os valores da família; o filtro mostra o de cada um.
• Os áudios ficam guardados só por 7 dias.
• O app não acessa sua conta no banco e não pede senha de banco — nunca informe senhas de banco aqui.`,
  },
  {
    id: "preferencias", titulo: "Tema claro/escuro, ordem dos lançamentos e Face ID",
    chaves: { tema: 4, escuro: 4, claro: 3, "modo noturno": 4, ordem: 3, crescente: 4, decrescente: 4, "face id": 5, digital: 3, biometria: 4, bloqueio: 4, bloquear: 4, senha: 1 },
    texto: `⚙️ *Preferências* (em *Configurações → Aparência e segurança*)
• *Tema*: Automático (segue o celular), Claro ou Escuro.
• *Ordem dos lançamentos*: mais recentes primeiro ou mais antigos primeiro.
• *Bloqueio com Face ID / digital*: toque em *Ativar bloqueio* e confirme com o rosto ou a digital. Ao abrir o app (ou voltar depois de 2 minutos), ele pede a biometria. Vale só para aquele celular. No iPhone funciona no app instalado pelo Safari; no Android, pelo Chrome. Se a biometria falhar, dá para entrar com e-mail e senha.`,
  },
  {
    id: "zerar", titulo: "Zerar a conta (recomeçar do zero)",
    chaves: { zerar: 5, reiniciar: 4, "apagar tudo": 5, "comecar do zero": 5, recomecar: 4, resetar: 4, limpar: 3 },
    texto: `🧹 *Zerar a conta* (só o titular da família)
*Configurações → Conta → Zerar a conta…* Apaga todos os lançamentos e zera os saldos iniciais. Você escolhe se também apaga contas fixas, orçamentos, metas e cartões/contas. Para confirmar, digite *ZERAR*. Não dá para desfazer.`,
  },
  {
    id: "cupom", titulo: "Foto de cupom ou nota fiscal",
    chaves: { cupom: 5, "nota fiscal": 5, nota: 2, recibo: 3, "bater foto": 4, "tirar foto": 4, foto: 2, camera: 3, nfce: 4 },
    texto: `🧾 *Foto do cupom ou nota fiscal*
Na aba *Assistente*, toque no botão da *câmera* (ao lado do microfone), tire a foto do cupom (ou escolha da galeria). Eu leio a loja, a data, o total e a forma de pagamento e lanço a despesa na categoria certa. Se foi no cartão de crédito e você tem mais de um, eu pergunto qual. No Telegram, é só mandar a foto.
Dica: foto reta, com boa luz e o cupom inteiro aparecendo.`,
  },
  {
    id: "mercado", titulo: "Mercado: indicadores e simulador de investimentos",
    chaves: { mercado: 3, indicador: 4, simulador: 4, simular: 3, "tela mercado": 4, cotac: 3, "atualiza a selic": 3 },
    texto: `📈 *Mercado* (menu *Mercado*)
• *Indicadores oficiais* do Banco Central: Selic, CDI, IPCA, IGP-M, poupança, dólar e euro, com gráfico recente. O app busca os números sozinho e atualiza a cada 6 horas (ou toque em *Atualizar*).
• *Simulador*: informe valor inicial, aporte mensal e prazo, marque as aplicações (poupança, CDB, LCI/LCA, Tesouro Selic, prefixado, IPCA+) e toque em *Simular*. Mostra investido, imposto de renda e valor líquido de cada uma, lado a lado.
• Pelo chat: “qual a Selic hoje?”, “quanto está o dólar?”, “quanto rende 10 mil no CDB 110% do CDI em 2 anos?”, “o que é LCI?”.
• *Comparar o seu saldo*: “compare o saldo da conta Banrisul com o mercado em 1 ano” — eu pego o saldo da conta e mostro quanto ficaria em cada aplicação (e parado na conta). Se faltar a conta ou o prazo, eu pergunto.
• Importante: o app *não recomenda nem escolhe* investimentos — ele só apresenta informações e simulações. A decisão é sempre sua.`,
  },
  {
    id: "consultas", titulo: "Perguntas que posso responder",
    chaves: { "o que voce faz": 4, "o que posso perguntar": 4, "o que voce sabe": 4, funcionalidad: 3, "tudo que": 1, "pra que serve": 2, "para que serve": 2 },
    texto: `🧠 *O que você pode me perguntar*
• Gastos: “quanto gastei este mês?”, “quanto gastei com alimentação?”, “qual minha maior despesa?”
• Saldo e futuro: “quanto tenho na conta?”, “quanto posso gastar até o fim do mês?”, “posso comprar um celular de 1.800?”
• Cartões: “quanto está a fatura?”, “quais parcelas tenho?”
• Planejamento: “como estão minhas metas?”, “como está meu orçamento?”, “tenho algum alerta?”
• Família: “quanto a Bruna gastou?”, “quanto devo?”
• Dúvidas sobre o app: “como conecto o Telegram?”, “como instalo o app?”, “o microfone fica pedindo permissão”.`,
  },
];

// ---------------------------------------------------------------------------
const HOWTO = /\b(como (?:eu |que |posso |a gente |faco|faz|fazer|uso|usar|funciona|cadastr|lanc|coloc|conect|instal|import|export|apag|exclu|corrig|edit|mud|troc|cri|adicion|marc|vej|ver|pago|pag|recebo|divid|convid|ativ|desativ|tir|baix|abr|consig|configur|mand|envi|grav|ouc|ouvir|acess|entr|sai|atualiz|registr|anot|defin|guard)\w*|onde (?:fica|vejo|eu|esta|tem|acho|encontro|clico|toco)|aonde|o que (?:e|significa|quer dizer)|o que sao|pra que serve|para que serve|qual a diferenca|nao consigo|nao estou conseguindo|nao aparece|nao apareceu|nao funciona|nao carrega|nao responde|nao deixa|deu erro|da erro|esta dando|fica pedindo|pede toda vez|me ensina|ensina|me explica|explica|tem como|da pra|da para|e possivel|consigo|duvida|tutorial|passo a passo|manual|ajuda com|ajuda para|ajuda pra|sem conexao)\b/;
// consultas de finanças que começam parecido mas NÃO são dúvidas sobre o app
const FINANCE_Q = /\b(como (?:esta|estao|anda|andam|vai|vao|ficou|fica|estou|estamos)|quanto|qual (?:minha|meu|foi)|posso comprar|posso gastar)\b/;

export function isAppQuestion(text: string): boolean {
  const f = fold(text);
  if (FINANCE_Q.test(f) && !/\b(como (?:faco|uso|usar|funciona)|onde|nao consigo)\b/.test(f)) return false;
  if (HOWTO.test(f) || /^(manual|ajuda do app|central de ajuda|duvidas?)\b/.test(f.trim())) return true;
  // fala do próprio app ("o app não atualizou", "o aplicativo travou") com um assunto do manual
  return /\b(o app|no app|do app|aplicativo|o site)\b/.test(f) && (searchManual(text, 1)[0]?.score ?? 0) >= 3;
}

export function searchManual(text: string, max = 3): { topic: Topic; score: number }[] {
  const f = " " + fold(text).replace(/[^\p{L}\d+/ ]/gu, " ").replace(/\s+/g, " ") + " ";
  return TOPICS.map((topic) => ({
    topic,
    score: Object.entries(topic.chaves).reduce((s, [k, w]) => s + (f.includes(k.length <= 4 ? ` ${k}` : k) ? w : 0), 0),
  })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
}

export const topicIndex = () => TOPICS.map((t) => `• ${t.titulo}`).join("\n");

/** Resposta de ajuda para uma dúvida sobre o app, ou null se não reconhecer o assunto. */
export function manualAnswer(text: string): string | null {
  const f = fold(text).trim();
  if (/^(manual|central de ajuda|ajuda do app|duvidas?|o que voce (?:sabe )?explica\w*)\b/.test(f)) {
    return `📘 *Manual do app* — pergunte sobre qualquer assunto, por exemplo “como conecto o Telegram?”:\n${topicIndex()}`;
  }
  const r = searchManual(text);
  if (!r.length || r[0].score < 2) return null;
  const rel = r.slice(1).filter((x) => x.score >= Math.max(2, r[0].score - 1)).map((x) => `“${x.topic.titulo}”`);
  return r[0].topic.texto + (rel.length ? `\n\nTambém posso explicar: ${rel.join(", ")}.` : "");
}
