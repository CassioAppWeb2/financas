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
  [["aluguel"], null, "Moradia", "Aluguel"],
  [["condominio"], "despesa", "Moradia", "Condomínio"],
  [["luz", "energia", "conta de luz", "enel", "cemig", "copel", "light", "celpe", "coelba", "eletricidade"], "despesa", "Moradia", "Energia"],
  [["agua", "conta de agua", "sabesp", "saneamento", "copasa", "cedae", "sanepar"], "despesa", "Moradia", "Água"],
  [["gas", "botijao"], "despesa", "Moradia", "Gás"],
  [["internet", "wifi", "wi-fi", "fibra", "vivo fibra", "claro net", "net"], "despesa", "Moradia", "Internet"],
  [["reforma", "pedreiro", "encanador", "eletricista", "material de construcao", "conserto da casa"], "despesa", "Moradia", "Manutenção"],
  // Transporte
  [["gasolina", "combustivel", "posto", "etanol", "alcool", "diesel", "abasteci", "abastecer", "shell", "ipiranga", "petrobras"], "despesa", "Transporte", "Combustível"],
  [["uber", "99 pop", "99pop", "99 taxi", "taxi", "cabify", "corrida"], "despesa", "Transporte", "Uber"],
  [["onibus", "metro", "trem", "passagem de onibus", "bilhete unico", "brt", "vlt"], "despesa", "Transporte", "Transporte público"],
  [["estacionamento", "zona azul", "valet"], "despesa", "Transporte", "Estacionamento"],
  [["pedagio", "sem parar", "conectcar", "veloe"], "despesa", "Transporte", "Pedágio"],
  [["mecanico", "oficina", "troca de oleo", "pneu", "pneus", "revisao do carro", "funilaria", "borracharia", "lava jato", "lavagem"], "despesa", "Transporte", "Manutenção"],
  // Saúde
  [["consulta", "medico", "medica", "psicologo", "psicologa", "terapia", "fisioterapia"], "despesa", "Saúde", "Consultas"],
  [["exame", "exames", "laboratorio", "raio x", "ultrassom"], "despesa", "Saúde", "Exames"],
  [["farmacia", "remedio", "remedios", "medicamento", "medicamentos", "drogaria", "drogasil", "pacheco"], "despesa", "Saúde", "Medicamentos"],
  [["plano de saude", "unimed", "amil", "bradesco saude", "hapvida", "sulamerica"], "despesa", "Saúde", "Plano de saúde"],
  [["dentista", "odontologia", "ortodontista", "aparelho dentario"], "despesa", "Saúde", "Odontologia"],
  // Educação
  [["escola", "faculdade", "mensalidade escolar", "colegio", "universidade"], "despesa", "Educação", "Escola"],
  [["curso", "cursos", "udemy", "alura", "aula", "aulas"], "despesa", "Educação", "Cursos"],
  [["livro", "livros", "livraria"], "despesa", "Educação", "Livros"],
  [["material escolar", "papelaria", "caderno", "cadernos"], "despesa", "Educação", "Material"],
  // Vestuário
  [["roupa", "roupas", "camisa", "camiseta", "calca", "vestido", "blusa", "bermuda", "jaqueta", "casaco", "renner", "riachuelo", "cea", "shein"], "despesa", "Vestuário", "Roupas"],
  [["tenis", "sapato", "sapatos", "sandalia", "chinelo", "bota", "calcado", "calcados"], "despesa", "Vestuário", "Calçados"],
  [["bolsa", "relogio", "oculos", "bijuteria", "brinco", "colar", "acessorio", "acessorios", "cinto"], "despesa", "Vestuário", "Acessórios"],
  // Lazer
  [["viagem", "hotel", "pousada", "passagem aerea", "airbnb", "hospedagem", "passagem de aviao"], "despesa", "Lazer", "Viagens"],
  [["cinema", "filme"], "despesa", "Lazer", "Cinema"],
  [["show", "evento", "ingresso", "ingressos", "teatro", "festa", "balada", "bar", "barzinho", "cerveja"], "despesa", "Lazer", "Eventos"],
  [["jogo", "jogos", "game", "games", "steam", "playstation", "xbox"], "despesa", "Lazer", "Jogos"],
  [["netflix", "spotify", "streaming", "disney", "prime video", "amazon prime", "hbo", "max", "globoplay", "youtube premium", "deezer", "apple tv", "paramount"], "despesa", "Lazer", "Streaming"],
  // Financeiro
  [["tarifa", "tarifas", "anuidade", "taxa bancaria", "cesta de servicos"], "despesa", "Financeiro", "Tarifas"],
  [["juros"], "despesa", "Financeiro", "Juros"],
  [["iof"], "despesa", "Financeiro", "IOF"],
  [["emprestimo", "financiamento", "consignado"], "despesa", "Financeiro", "Empréstimos"],
  // Bens diversos -> Outros (o usuário pode corrigir)
  [["tv", "televisao", "celular", "geladeira", "notebook", "computador", "fogao", "microondas", "maquina de lavar", "sofa", "cama", "movel", "moveis", "eletrodomestico", "presente", "presentes"], "despesa", "Outros", undefined, 0.7],
  // Receitas
  [["salario", "pagamento do mes", "holerite", "adiantamento salarial", "decimo terceiro", "13o", "ferias"], "receita", "Salário", undefined],
  [["pro-labore", "pro labore", "prolabore"], "receita", "Pró-labore", undefined],
  [["venda", "vendas", "vendi", "encomenda", "encomendas", "pedido de cliente"], "receita", "Vendas", undefined],
  [["freela", "freelance", "freelancer", "bico", "job"], "receita", "Freelance", undefined],
  [["rendimento", "rendimentos", "rendeu", "juros da poupanca", "cdb rendeu"], "receita", "Rendimentos", undefined],
  [["dividendo", "dividendos", "jcp"], "receita", "Investimentos", undefined],
  [["cliente"], "receita", "Vendas", undefined, 0.6],
  [["empresa"], "receita", "Pró-labore", undefined, 0.6],
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
      if (tipo === "receita") return { tipo, categoria: "Aluguel recebido", confianca: 0.9, termo };
      return { tipo: "despesa", categoria, subcategoria: sub, confianca: 0.9, termo };
    }
    if (tipo && t && t !== tipo) continue;
    return { tipo: t ?? tipo, categoria, subcategoria: sub, confianca: conf ?? 0.9, termo };
  }
  return null;
}
