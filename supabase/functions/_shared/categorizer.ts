// Classificação automática por palavras-chave (antes de consultar qualquer IA).
// O aprendizado por estabelecimento fica no banco (establishment_categories).
import { norm } from "./text.ts";

export interface CategoryGuess {
  tipo?: "despesa" | "receita";
  categoria: string;
  subcategoria?: string;
  confianca: number;
  termo: string;
}

type Rule = [string[], "despesa" | "receita" | null, string, string | undefined, number?];

// [palavras-chave, tipo, categoria, subcategoria, confiança]
const RULES: Rule[] = [
  // Alimentação
  [["supermercado", "mercado", "mercadinho", "atacadao", "atacarejo", "assai", "carrefour", "hortifruti", "sacolao", "feira", "compras do mes", "pao de acucar"], "despesa", "Alimentação", "Supermercado"],
  [["padaria", "pao", "paes", "panificadora"], "despesa", "Alimentação", "Padaria"],
  [["restaurante", "almoco", "almocei", "jantar", "jantei", "churrascaria", "self service", "rodizio", "marmita", "marmitex", "pf"], "despesa", "Alimentação", "Restaurante"],
  [["ifood", "delivery", "rappi", "pizza", "pizzaria", "hamburguer", "hamburgueria", "sushi", "esfiha"], "despesa", "Alimentação", "Delivery"],
  [["lanche", "lanchonete", "cafe", "cafeteria", "salgado", "pastel", "sorvete", "acai", "doceria", "coxinha"], "despesa", "Alimentação", "Lanches"],
  // Moradia
  [["aluguel"], null, "Moradia e contas da casa", "Aluguel"],
  [["condominio"], "despesa", "Moradia e contas da casa", "Condomínio"],
  [["luz", "energia", "conta de luz", "enel", "cemig", "copel", "light", "celpe", "coelba", "eletricidade"], "despesa", "Moradia e contas da casa", "Luz"],
  [["agua", "conta de agua", "sabesp", "saneamento", "copasa", "cedae", "sanepar"], "despesa", "Moradia e contas da casa", "Água"],
  [["gas", "botijao"], "despesa", "Moradia e contas da casa", "Gás"],
  [["internet", "wifi", "wi-fi", "fibra", "vivo fibra", "claro net", "net"], "despesa", "Moradia e contas da casa", "Internet"],
  [["reforma", "pedreiro", "encanador", "eletricista", "material de construcao", "conserto da casa"], "despesa", "Moradia e contas da casa", "Manutenção"],
  // Transporte
  [["gasolina", "combustivel", "posto", "etanol", "alcool", "diesel", "abasteci", "abastecer", "shell", "ipiranga", "petrobras"], "despesa", "Transporte", "Combustível"],
  [["uber", "99 pop", "99pop", "99 taxi", "taxi", "cabify", "corrida"], "despesa", "Transporte", "Uber e táxi"],
  [["onibus", "metro", "trem", "passagem de onibus", "bilhete unico", "brt", "vlt"], "despesa", "Transporte", "Ônibus e metrô"],
  [["estacionamento", "zona azul", "valet"], "despesa", "Transporte", "Estacionamento"],
  [["pedagio", "sem parar", "conectcar", "veloe"], "despesa", "Transporte", "Pedágio"],
  [["mecanico", "oficina", "troca de oleo", "pneu", "pneus", "revisao do carro", "funilaria", "borracharia", "lava jato", "lavagem"], "despesa", "Transporte", "Manutenção"],
  // Saúde
  [["consulta", "medico", "medica", "psicologo", "psicologa", "terapia", "fisioterapia"], "despesa", "Saúde", "Consultas"],
  [["exame", "exames", "laboratorio", "raio x", "ultrassom"], "despesa", "Saúde", "Exames"],
  [["farmacia", "remedio", "remedios", "medicamento", "medicamentos", "drogaria", "drogasil", "pacheco"], "despesa", "Saúde", "Farmácia"],
  [["plano de saude", "unimed", "amil", "bradesco saude", "hapvida", "sulamerica"], "despesa", "Saúde", "Plano de saúde"],
  [["dentista", "odontologia", "ortodontista", "aparelho dentario"], "despesa", "Saúde", "Dentista"],
  // Educação
  [["escola", "faculdade", "mensalidade escolar", "colegio", "universidade"], "despesa", "Educação", "Escola"],
  [["curso", "cursos", "udemy", "alura", "aula", "aulas"], "despesa", "Educação", "Cursos"],
  [["livro", "livros", "livraria"], "despesa", "Educação", "Livros"],
  [["material escolar", "papelaria", "caderno", "cadernos"], "despesa", "Educação", "Material escolar"],
  // Vestuário
  [["roupa", "roupas", "camisa", "camiseta", "calca", "vestido", "blusa", "bermuda", "jaqueta", "casaco", "renner", "riachuelo", "cea", "shein"], "despesa", "Vestuário", "Roupas"],
  [["tenis", "sapato", "sapatos", "sandalia", "chinelo", "bota", "calcado", "calcados"], "despesa", "Vestuário", "Calçados"],
  [["bolsa", "relogio", "oculos", "bijuteria", "brinco", "colar", "acessorio", "acessorios", "cinto"], "despesa", "Vestuário", "Acessórios"],
  // Lazer
  [["viagem", "hotel", "pousada", "passagem aerea", "airbnb", "hospedagem", "passagem de aviao"], "despesa", "Viagens", undefined],
  [["cinema", "filme"], "despesa", "Lazer e entretenimento", "Cinema"],
  [["show", "evento", "ingresso", "ingressos", "teatro", "festa", "balada", "bar", "barzinho", "cerveja"], "despesa", "Lazer e entretenimento", "Eventos e shows"],
  [["jogo", "jogos", "game", "games", "steam", "playstation", "xbox"], "despesa", "Lazer e entretenimento", "Jogos"],
  [["netflix", "spotify", "streaming", "disney", "prime video", "amazon prime", "hbo", "max", "globoplay", "youtube premium", "deezer", "apple tv", "paramount"], "despesa", "Assinaturas e serviços", "Streaming"],
  // Financeiro
  [["tarifa", "tarifas", "anuidade", "taxa bancaria", "cesta de servicos"], "despesa", "Impostos e taxas", "Tarifas bancárias"],
  [["juros"], "despesa", "Dívidas e empréstimos", "Juros"],
  [["iof"], "despesa", "Impostos e taxas", "IOF"],
  [["emprestimo", "financiamento", "consignado"], "despesa", "Dívidas e empréstimos", "Empréstimos"],
  [["acougue", "carne", "carnes", "frigorifico"], "despesa", "Alimentação", "Açougue"],
  [["ipva"], "despesa", "Transporte", "IPVA"],
  [["iptu"], "despesa", "Impostos e taxas", "IPTU"],
  [["seguro do carro", "seguro auto", "seguro do veiculo"], "despesa", "Seguros", "Seguro do carro"],
  [["seguro residencial", "seguro da casa"], "despesa", "Seguros", "Seguro residencial"],
  [["seguro de vida"], "despesa", "Seguros", "Seguro de vida"],
  [["racao", "veterinario", "pet shop", "petshop", "banho e tosa"], "despesa", "Pets", undefined],
  [["cabeleireiro", "salao", "barbearia", "barbeiro", "manicure", "estetica", "depilacao"], "despesa", "Cuidados pessoais", undefined],
  [["academia", "smartfit", "smart fit", "crossfit", "pilates"], "despesa", "Cuidados pessoais", "Academia"],
  [["brinquedo", "brinquedos", "mesada", "fralda", "fraldas"], "despesa", "Filhos e família", undefined],
  [["icloud", "google one", "dropbox", "aplicativo", "app store", "google play"], "despesa", "Assinaturas e serviços", undefined],
  [["doacao", "dizimo", "oferta da igreja"], "despesa", "Outros gastos", "Doações"],
  [["multa", "juros de atraso"], "despesa", "Dívidas e empréstimos", "Multas por atraso"],
  [["inss", "aposentadoria", "pensao"], "receita", "Aposentadoria e pensão", undefined],
  [["reembolso", "estorno", "devolucao"], "receita", "Reembolsos", undefined],
  [["horas extras", "hora extra"], "receita", "Salário e remuneração", "Horas extras"],
  [["comissao", "comissoes"], "receita", "Salário e remuneração", "Comissões"],
  // Bens diversos -> Outros (o usuário pode corrigir)
  [["tv", "televisao", "celular", "geladeira", "notebook", "computador", "fogao", "microondas", "maquina de lavar", "sofa", "cama", "movel", "moveis", "eletrodomestico"], "despesa", "Compras pessoais e casa", undefined, 0.7],
  [["presente", "presentes"], "despesa", "Outros gastos", "Presentes", 0.8],
  // Receitas
  [["salario", "pagamento do mes", "holerite", "adiantamento salarial", "decimo terceiro", "13o", "ferias"], "receita", "Salário e remuneração", "Salário"],
  [["pro-labore", "pro labore", "prolabore"], "receita", "Negócios e vendas", "Pró-labore"],
  [["venda", "vendas", "vendi", "encomenda", "encomendas", "pedido de cliente"], "receita", "Negócios e vendas", "Vendas"],
  [["freela", "freelance", "freelancer", "bico", "job"], "receita", "Renda extra", "Freelances"],
  [["rendimento", "rendimentos", "rendeu", "juros da poupanca", "cdb rendeu"], "receita", "Investimentos", "Rendimentos de aplicações"],
  [["dividendo", "dividendos", "jcp"], "receita", "Investimentos", "Dividendos"],
  [["cliente"], "receita", "Negócios e vendas", "Vendas", 0.6],
  [["empresa"], "receita", "Negócios e vendas", "Pró-labore", 0.6],
];

// Índice ordenado: termos mais longos primeiro ("conta de luz" antes de "luz")
const INDEX: { termo: string; re: RegExp; rule: Rule }[] = RULES
  .flatMap((rule) => rule[0].map((termo) => ({ termo, re: new RegExp(`(^|[^a-z0-9])${termo.replace(/[-]/g, "[- ]?")}([^a-z0-9]|$)`), rule })))
  .sort((a, b) => b.termo.length - a.termo.length);

/** Palpite de categoria pelas palavras da frase. tipo: restringe a receitas ou despesas. */
export function guessCategory(text: string, tipo?: "despesa" | "receita"): CategoryGuess | null {
  const n = norm(text);
  for (const { termo, re, rule } of INDEX) {
    const [, t, categoria, sub, conf] = rule;
    if (!re.test(n)) continue;
    if (termo === "aluguel") {
      if (tipo === "receita") return { tipo, categoria: "Aluguéis recebidos", subcategoria: "Imóveis", confianca: 0.9, termo };
      return { tipo: "despesa", categoria, subcategoria: sub, confianca: 0.9, termo };
    }
    if (tipo && t && t !== tipo) continue;
    return { tipo: t ?? tipo, categoria, subcategoria: sub, confianca: conf ?? 0.9, termo };
  }
  return null;
}
