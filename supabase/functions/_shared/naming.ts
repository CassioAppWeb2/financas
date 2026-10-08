// Nome do assistente: a pessoa pode batizar o assistente ("Jarbas") e chamá-lo pelo nome.
// Tudo aqui trabalha numa cópia "dobrada" do texto (minúsculas, sem acentos) com o MESMO
// comprimento do original, para recortar o trecho certo do texto original.

/** minúsculas e sem acentos, caractere por caractere (mantém o comprimento) */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const base = ch.normalize("NFD")[0] ?? ch;
    const f = base.toLowerCase();
    out += f.length === ch.length ? f : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GREET = "(?:oi+|ol[aá]|ola|e ?a[ií]|ei|ou|ô|o|hey|hello|alo|al[ôo]|bom dia|boa tarde|boa noite|fala)";

/**
 * Tira o vocativo ("Jarbas, gastei 50 no mercado", "gastei 50, Jarbas", "oi Jarbas").
 * Devolve o texto sem o nome e se a pessoa chamou o assistente pelo nome.
 */
export function stripVocative(text: string, name?: string | null): { text: string; chamou: boolean } {
  const nm = fold((name ?? "").trim());
  if (nm.length < 2) return { text, chamou: false };
  const f = fold(text);
  const n = esc(nm).replace(/\s+/g, "\\s+");
  // início: [saudação] NOME [, ! : -]
  const ini = new RegExp(`^\\s*(${GREET}[\\s,!.]+)?${n}(?![\\p{L}\\d])[\\s,!:;.\\-–—]*`, "u").exec(f);
  if (ini) {
    const greet = ini[1] ? text.slice(0, ini[1].length).replace(/[\s,!.]+$/, "") : "";
    const rest = text.slice(ini[0].length).trim();
    return { text: [greet, rest].filter(Boolean).join(", "), chamou: true };
  }
  // fim: ..., NOME[?!.]
  const fim = new RegExp(`[\\s,]+${n}\\s*([?!.]*)\\s*$`, "u").exec(f);
  if (fim && fim.index > 0) return { text: text.slice(0, fim.index).trim() + (fim[1] ?? ""), chamou: true };
  return { text, chamou: false };
}

const RENAME = new RegExp([
  "seu nome (?:agora |a partir de agora )?(?:e|eh|é|vai ser|sera|será|passa a ser|fica)\\s+",
  "(?:eu )?(?:pode|posso|vou|quero|vamos|gostaria de)\\s+(?:te\\s+)?chamar\\s+(?:voce\\s+|você\\s+)?de\\s+",
  "\\bte chamar de\\s+",
  "(?:^\\s*|\\bvoce |\\bvocê )(?:pode|vai|passa a)\\s+se chamar\\s+",
  "(?:mud[ea]r?|troc[ae]r?|alter[ae]r?)\\s+(?:o\\s+)?(?:seu nome|nome do assistente|teu nome)\\s+(?:para|pra)\\s+",
  "(?:a partir de agora|de agora em diante),?\\s+(?:(?:voce |você )?(?:se chama|vai se chamar)|(?:voce|você) (?:e|é))\\s+(?:o |a )?",
  "\\b(?:te batizo|vou te batizar) (?:de|como)\\s+",
].map((p) => `(?:${p})`).join("|"));

const RESET = /\b(tir[ae]r? (?:o )?seu nome|apag[ae]r? (?:o )?seu nome|volt[ea]r? a se chamar (?:so |só )?assistente|(?:fique|fica|ficar) sem nome|esquec[ea]r? (?:o )?seu nome)\b/;
const ASK = /\b(qual (?:e |eh |é )?(?:o )?(?:seu|teu) nome|como (?:voce |você |tu )?se chama|quem (?:e|é|eh) voce|quem (?:e|é|eh) você|voce tem nome|você tem nome|qual (?:e |é )?seu nome)\b/;

/** Nome pedido ("pode se chamar Jarbas"); "" = tirar o nome; null = pediu mas não disse qual; undefined = não é isso. */
export function detectRename(text: string): string | null | undefined {
  const f = fold(text);
  if (RESET.test(f)) return "";
  const m = RENAME.exec(f + " ");
  if (!m) return undefined;
  const raw = (text + " ").slice(m.index + m[0].length)
    .split(/[,.;!?\n]|\s+(?:e|que|porque|pq|ok|tá|ta|beleza)\s+/i)[0]
    .replace(/["“”'‘’*_]/g, "").trim();
  const palavras = raw.split(/\s+/).filter(Boolean).filter((w, i) => !(i === 0 && /^(o|a|de)$/i.test(w))).slice(0, 3);
  const nome = palavras.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return nome || null;
}

export function asksName(text: string): boolean {
  return ASK.test(fold(text));
}

/** Validação simples (mesma regra do banco). */
export function validName(nome: string): string | null {
  if (nome.length < 2 || nome.length > 30) return "O nome precisa ter entre 2 e 30 letras.";
  if (!/^\p{L}[\p{L}\d '.-]*$/u.test(nome)) return "Use só letras no nome.";
  return null;
}
