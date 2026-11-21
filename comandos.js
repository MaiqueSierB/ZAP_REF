// Lógica dos comandos do WhatsApp. Recebe o texto e quem mandou, devolve a resposta.
// Não depende do Baileys, então dá pra testar sozinho.
import * as b from './bancos.js';
import { buscarFilmes, buscarJogos, antiJanja } from './apis.js';
import config from './config.js';

const P = config.prefixo;
const fmtNota = n => (n == null ? '—' : Number(n).toFixed(1));
const fmtData = iso => new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
});

// Última lista mostrada para cada pessoa (para "!nota 2 8" e "!palpite 3 2x1")
const ultimaBusca = new Map();   // chave remetente -> { tipo: 'filme'|'jogo', itens, quando }
const ultimoBolao = new Map();   // chave remetente -> [jogos]
const EXPIRA = 30 * 60_000;

export const AJUDA =
`*🤖 Bot do Regresso no Zap*

*🎬 Filmes e séries (RMDB)*
${P}filme duna — procura e mostra a nota do servidor
${P}nota 1 8.5 — dá nota pro item 1 da última busca
${P}top filmes — melhores do servidor

*🎮 Jogos (RGDB)*
${P}game elden ring — procura o jogo
${P}nota 1 9 zerei — nota (+ joguei, zerei ou platinei)
${P}top games — melhores do servidor

*⚽ Bolão do Brasileirão*
${P}bolao — próximos jogos abertos
${P}palpite 1 2x1 — palpite no jogo 1 da lista
${P}meuspalpites — seus últimos palpites
${P}ranking — ranking geral

*📺 Anti Janja (transmissão de tela)*
${P}transmitir — cria uma sala e manda o link aqui
${P}parar — encerra a sua sala

*🔗 Conta*
${P}vincular 123456 — liga seu Zap ao Discord (gere o código com /zap no Discord)
${P}desvincular — desfaz o vínculo`;

const precisaVinculo = `🔗 Primeiro vincule seu Zap ao Discord: use */zap* no Discord e mande aqui *${P}vincular CÓDIGO*.`;

export async function tratar(texto, remetente, chatId) {
    const t = texto.trim();
    if (!t.startsWith(P)) return null;
    const [cmdBruto, ...resto] = t.slice(P.length).trim().split(/\s+/);
    const cmd = (cmdBruto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const arg = resto.join(' ').trim();
    const chave = remetente.ids[0];
    const quem = b.quemE(remetente.ids);

    switch (cmd) {
        case 'ajuda': case 'help': case 'comandos':
            return AJUDA;

        case 'id':
            return `ID deste chat: ${chatId}`;

        case 'vincular': {
            const codigo = arg.replace(/\D/g, '');
            if (!codigo) return `Use: ${P}vincular 123456 (gere o código com /zap no Discord)`;
            const c = b.vincular(codigo, remetente.ids);
            return c ? `✅ Vinculado! Agora suas notas e palpites daqui contam como *${c.nome}* do Discord.`
                : '❌ Código inválido ou expirado. Gere outro com /zap no Discord (vale 10 minutos).';
        }

        case 'desvincular':
            return b.desvincular(remetente.ids) ? '✅ Vínculo removido.' : 'Você não tinha vínculo.';

        case 'filme': case 'serie': case 'filmes': {
            if (!arg) return `Use: ${P}filme nome do filme ou série`;
            const itens = await buscarFilmes(arg);
            if (!itens.length) return '🔎 Não achei nada com esse nome.';
            ultimaBusca.set(chave, { tipo: 'filme', itens, quando: Date.now() });
            return `🎬 *Resultados para "${arg}"*\n` + itens.map((f, i) => {
                const n = b.notaFilme(f.id);
                return `*${i + 1}.* ${f.titulo}${f.ano ? ` (${f.ano})` : ''} · ${f.tipo} · ⭐ ${n ? `${fmtNota(n.server_score)} (${n.vote_count} votos)` : 'sem nota'}`;
            }).join('\n') + `\n\nPra dar nota: *${P}nota 1 8.5*`;
        }

        case 'game': case 'games': case 'jogo': {
            if (!arg) return `Use: ${P}game nome do jogo`;
            const itens = await buscarJogos(arg);
            if (!itens.length) return '🔎 Não achei nenhum jogo com esse nome.';
            ultimaBusca.set(chave, { tipo: 'jogo', itens, quando: Date.now() });
            return `🎮 *Resultados para "${arg}"*\n` + itens.map((g, i) => {
                const n = b.notaJogo(g.id);
                return `*${i + 1}.* ${g.titulo}${g.ano ? ` (${g.ano})` : ''} · ⭐ ${n ? `${fmtNota(n.server_score)} (${n.vote_count} votos)` : 'sem nota'}`;
            }).join('\n') + `\n\nPra dar nota: *${P}nota 1 9 zerei* (joguei, zerei ou platinei)`;
        }

        case 'nota': case 'avaliar': {
            if (!quem) return precisaVinculo;
            const busca = ultimaBusca.get(chave);
            if (!busca || Date.now() - busca.quando > EXPIRA) return `Primeiro procure com *${P}filme nome* ou *${P}game nome*.`;
            const [numStr, notaStr, statusStr] = resto;
            const item = busca.itens[Number(numStr) - 1];
            const nota = Number(String(notaStr ?? '').replace(',', '.'));
            if (!item) return `Número inválido. Escolha de 1 a ${busca.itens.length}.`;
            if (!Number.isFinite(nota) || nota < 0 || nota > 10) return 'Nota inválida. Use de 0 a 10 (ex.: 8.5).';
            if (busca.tipo === 'filme') {
                const s = b.votarFilme(quem.discord_id, quem.nome, item.id, item.titulo, nota);
                return `✅ Nota *${fmtNota(nota)}* para *${item.titulo}*. Média do servidor: ⭐ *${fmtNota(s.avg)}* (${s.total} votos).`;
            }
            const status = (statusStr || 'joguei').toLowerCase();
            if (!b.STATUS_JOGO.includes(status)) return `Status inválido. Use: ${b.STATUS_JOGO.join(', ')}.`;
            const s = b.votarJogo(quem.discord_id, quem.nome, item.id, item.titulo, nota, status);
            return `✅ Nota *${fmtNota(nota)}* para *${item.titulo}* (${s.status}, +${s.ganho} XP, nível ${s.level}). ` +
                `Média do servidor: ⭐ *${fmtNota(s.avg)}* (${s.total} votos).`;
        }

        case 'top': {
            const jogos = /game|jogo/i.test(arg);
            const lista = jogos ? b.topJogos(10) : b.topFilmes(10);
            if (!lista.length) return 'Ainda não tem nada avaliado.';
            return `${jogos ? '🎮 *Top games do servidor*' : '🎬 *Top filmes e séries do servidor*'}\n` +
                lista.map((x, i) => `*${i + 1}.* ${x.title} — ⭐ ${fmtNota(x.server_score)} (${x.vote_count})`).join('\n');
        }

        case 'bolao': case 'jogos': {
            const lista = b.bolaoAbertos(10);
            if (!lista.length) return '⚽ Nenhum jogo aberto para palpite agora.';
            ultimoBolao.set(chave, lista);
            return `⚽ *Bolão — próximos jogos*\n` +
                lista.map((j, i) => `*${i + 1}.* ${j.casa} x ${j.fora} — ${fmtData(j.data_utc)} (R${j.rodada})`).join('\n') +
                `\n\nPra palpitar: *${P}palpite 1 2x1*`;
        }

        case 'palpite': case 'palpitar': {
            if (!quem) return precisaVinculo;
            const m = arg.match(/^(\d+)\s+(\d{1,2})\s*[xX×-]\s*(\d{1,2})$/);
            if (!m) return `Use: *${P}palpite 1 2x1* (número do jogo na lista do ${P}bolao e o placar)`;
            const lista = ultimoBolao.get(chave) || b.bolaoAbertos(10);
            const j = lista[Number(m[1]) - 1];
            if (!j) return `Número inválido. Veja a lista com *${P}bolao*.`;
            const ok = b.bolaoPalpitar(j.id, quem.discord_id, quem.nome, Number(m[2]), Number(m[3]));
            return ok ? `✅ Palpite: *${j.casa} ${m[2]} x ${m[3]} ${j.fora}*. Dá pra mudar até o apito inicial.`
                : '❌ Esse jogo já começou ou não aceita mais palpites.';
        }

        case 'meuspalpites': case 'meus': {
            if (!quem) return precisaVinculo;
            const lista = b.bolaoMeus(quem.discord_id);
            if (!lista.length) return 'Você ainda não palpitou.';
            return '⚽ *Seus últimos palpites*\n' + lista.map(p =>
                `${p.casa} x ${p.fora}: ${p.p_casa}x${p.p_fora}` +
                (p.gols_casa != null && p.status === 'FINISHED' ? ` → deu ${p.gols_casa}x${p.gols_fora}, *${p.pontos ?? 0} pts*` : '')
            ).join('\n');
        }

        case 'ranking': {
            const lista = b.bolaoRanking(10);
            if (!lista.length) return 'Ninguém pontuou no bolão ainda.';
            const med = i => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
            return '🏆 *Ranking do bolão*\n' + lista.map((r, i) => `${med(i)} ${r.nome} — *${r.pontos} pts* (${r.exatos} na mosca)`).join('\n');
        }

        case 'transmitir': case 'live': {
            if (!quem) return precisaVinculo;
            const r = await antiJanja('POST', quem.discord_id);
            return `📺 *Sala do Anti Janja ${r.nova ? 'criada' : 'já estava aberta'}* por ${quem.nome}!\n${r.link}\n\n` +
                `Qualquer um com o link pode assistir e transmitir a própria tela (pelo computador). ` +
                `A sala expira em ${r.expiraMin} min. Pra encerrar: *${P}parar*`;
        }

        case 'parar': {
            if (!quem) return precisaVinculo;
            const r = await antiJanja('DELETE', quem.discord_id);
            return r.encerrada ? '⏹️ Sala encerrada. Todo mundo foi desconectado.' : 'Você não tem sala aberta.';
        }

        default:
            return null; // comando desconhecido: fica quieto para não poluir o grupo
    }
}
