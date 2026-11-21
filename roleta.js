// !sorteio / !roleta: roleta de eliminação. O bot manda UMA mensagem e vai editando:
// a cada rodada risca uma opção sorteada, até sobrar a vencedora.
import { randomInt } from 'node:crypto';

export const COMANDOS_ROLETA = ['sorteio', 'roleta', 'sortear'];
const MAX_OPCOES = 30;
const MAX_EDICOES = 8;                 // edições seguidas parecem robô: com muita opção, sai mais de uma por rodada
const pausa = () => 3_500 + randomInt(2_000);   // 3,5 a 5,5 s entre rodadas (ritmo menos mecânico)
const rodando = new Set();             // um sorteio por conversa de cada vez
const espera = ms => new Promise(r => setTimeout(r, ms));

// Aceita opções separadas por vírgula, ponto e vírgula, barra vertical ou uma por linha
export function lerOpcoes(texto) {
    const corpo = texto.trim().replace(/^\S+/, '');   // tira o "!sorteio"
    const vistas = new Set();
    return corpo.split(/[\n,;|]+/).map(o => o.trim().slice(0, 60)).filter(o => {
        const k = o.toLowerCase();
        if (!o || vistas.has(k)) return false;
        vistas.add(k);
        return true;
    });
}

// Quantas opções saem em cada rodada: no máximo MAX_EDICOES rodadas, mais no começo,
// e a última rodada sempre tira só uma (o suspense fica pro final). Ex.: 30 opções → 4,4,4,4,4,4,4,1
export function planoDeRodadas(n) {
    const total = Math.min(MAX_EDICOES, n - 1);
    if (total <= 1) return n > 1 ? [n - 1] : [];
    const antes = total - 1, tirar = n - 2;
    const base = Math.floor(tirar / antes), extra = tirar % antes;
    return [...Array.from({ length: antes }, (_, i) => base + (i < extra ? 1 : 0)), 1];
}

function tela(opcoes, eliminadas, rodada, ultimas) {
    const linhas = opcoes.map(o => (eliminadas.includes(o) ? `❌ ~${o}~` : `✅ ${o}`));
    const saiu = ultimas?.length ? `\n\n💥 Saiu: ${ultimas.map(o => `*${o}*`).join(', ')}` : '\n\nRodando...';
    return `🎡 *ROLETA DO REGRESSO* — rodada ${rodada}\n\n${linhas.join('\n')}${saiu}`;
}

export async function tratarRoleta(sock, msg, texto) {
    const chat = msg.key.remoteJid;
    const responder = text => sock.sendMessage(chat, { text }, { quoted: msg });
    const opcoes = lerOpcoes(texto);

    if (opcoes.length < 2) {
        return responder('🎡 *Roleta de eliminação*\nMande as opções separadas por vírgula (ou uma por linha):\n' +
            '*!sorteio opção 1, opção 2, opção 3*\n\nO bot vai eliminando até sobrar a vencedora.');
    }
    if (opcoes.length > MAX_OPCOES) return responder(`Muita opção! O máximo é ${MAX_OPCOES}.`);
    if (rodando.has(chat)) return responder('⏳ Já tem uma roleta rodando aqui. Espera ela terminar.');

    rodando.add(chat);
    try {
        const restantes = [...opcoes];
        const eliminadas = [];
        let enviada = await sock.sendMessage(chat, { text: tela(opcoes, eliminadas, 0) }, { quoted: msg });
        let rodada = 0;

        for (const quantas of planoDeRodadas(opcoes.length)) {
            await espera(pausa());
            const saiu = [];
            for (let k = 0; k < quantas; k++) saiu.push(restantes.splice(randomInt(restantes.length), 1)[0]);
            eliminadas.push(...saiu);
            rodada++;
            const texto = tela(opcoes, eliminadas, rodada, saiu);
            // Edita a mesma mensagem; se o WhatsApp não deixar, manda uma nova e segue editando ela.
            try {
                await sock.sendMessage(chat, { text: texto, edit: enviada.key });
            } catch {
                enviada = await sock.sendMessage(chat, { text: texto });
            }
        }

        await espera(1_000);
        const ordem = eliminadas.map((o, i) => `${i + 1}. ${o}`).join('\n');
        await sock.sendMessage(chat, {
            text: `🏆 *DEU: ${restantes[0]}!*\n\nOrdem de eliminação:\n${ordem}`
        }, { quoted: msg });
    } finally {
        rodando.delete(chat);
    }
}
