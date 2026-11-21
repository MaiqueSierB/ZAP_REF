// !lembrar: lembretes no grupo (horário de Brasília).
//   !lembrar 20h racha            → hoje às 20h (ou amanhã, se já passou)
//   !lembrar sexta 20h30 racha    → próxima sexta
//   !lembrar amanhã 9h academia   /  !lembrar 25/12 10h ceia
//   !lembrar 30min tirar a pizza  /  !lembrar em 2h ligar pro fulano
import * as b from './bancos.js';

const DIAS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const MAX_PENDENTES = 10;
const MAX_DIAS = 60;
const semAcento = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Devolve { quando: Date, texto } ou null. `agora` é injetável para teste.
export function interpretar(entrada, agora = new Date()) {
    let resto = entrada.trim();
    const tira = re => { const m = semAcento(resto).match(re); if (m) resto = resto.slice(m[0].length).trim(); return m; };

    // Relativo: "30min", "em 2h", "daqui 1 hora", "daqui a 10 minutos"
    const rel = tira(/^(?:(?:em|daqui(?: a)?)\s+)?(\d{1,4})\s*(min|minutos?|m)\b/) ||
        tira(/^(?:em|daqui(?: a)?)\s+(\d{1,3})\s*(h|horas?)\b/);
    if (rel) {
        const n = Number(rel[1]);
        const ms = rel[2].startsWith('h') ? n * 3_600_000 : n * 60_000;
        return resto ? { quando: new Date(agora.getTime() + ms), texto: resto } : null;
    }

    // Dia: hoje / amanhã / depois de amanhã / dia da semana / DD/MM
    const data = new Date(agora);
    let diaDefinido = false;
    let m;
    if ((m = tira(/^depois de amanha\b/))) { data.setDate(data.getDate() + 2); diaDefinido = true; }
    else if ((m = tira(/^amanha\b/))) { data.setDate(data.getDate() + 1); diaDefinido = true; }
    else if ((m = tira(/^hoje\b/))) { diaDefinido = true; }
    else if ((m = tira(/^(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?\b/))) {
        const alvo = DIAS[m[1]];
        let delta = (alvo - data.getDay() + 7) % 7;
        if (delta === 0) delta = 7;                      // "sexta" dito numa sexta = próxima sexta
        data.setDate(data.getDate() + delta); diaDefinido = true;
    } else if ((m = tira(/^(\d{1,2})\/(\d{1,2})\b/))) {
        data.setMonth(Number(m[2]) - 1, Number(m[1]));
        if (data < agora) data.setFullYear(data.getFullYear() + 1);
        diaDefinido = true;
    }

    // Hora: "20h", "20h30", "20:30", "às 8h"
    tira(/^(?:as|a)\s+/);
    const h = tira(/^(\d{1,2})(?:h(\d{2})?|:(\d{2}))(?:min)?\b/);
    if (!h && !diaDefinido) return null;
    const hora = h ? Number(h[1]) : 9;                   // só o dia: avisa às 9h
    const minuto = h ? Number(h[2] ?? h[3] ?? 0) : 0;
    if (hora > 23 || minuto > 59) return null;
    data.setHours(hora, minuto, 0, 0);
    if (!diaDefinido && data <= agora) data.setDate(data.getDate() + 1);   // "20h" já passou: amanhã
    if (data <= agora || !resto) return null;
    return { quando: data, texto: resto.slice(0, 200) };
}

const fmt = d => d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function lembrar(arg, autor, chat) {
    const r = interpretar(arg);
    if (!r) {
        return '⏰ *Lembrete* — escreva: !lembrar <quando> <o quê>\n\n' +
            'Quando pode ser:\n• 20h (hoje)\n• amanhã 9h\n• sexta 20h30\n• 25/12 10h\n• 30min\n• em 2h';
    }
    if (r.quando.getTime() - Date.now() > MAX_DIAS * 86_400_000) return `Só consigo lembrar até ${MAX_DIAS} dias pra frente.`;
    if (b.lembretesPendentes(autor).length >= MAX_PENDENTES) return `Você já tem ${MAX_PENDENTES} lembretes. Cancele algum com *!cancelar*.`;
    const id = b.criarLembrete(chat, autor, r.texto, r.quando.getTime());
    return `✅ Lembrete #${id} marcado pra *${fmt(r.quando)}*: ${r.texto}`;
}

export function listar(autor) {
    const l = b.lembretesPendentes(autor);
    return l.length ? '⏰ *Seus lembretes*\n' + l.map(x => `#${x.id} — ${fmt(new Date(x.quando))}: ${x.texto}`).join('\n') +
        '\n\nPra cancelar: *!cancelar 12* (o número do lembrete)' : 'Você não tem lembretes marcados.';
}

export function cancelar(arg, autor) {
    const id = Number(String(arg).replace('#', ''));
    if (!id) return 'Use *!cancelar 12* (veja os números com *!lembretes*).';
    return b.cancelarLembrete(id, autor) ? `🗑️ Lembrete #${id} cancelado.` : 'Não achei esse lembrete entre os seus.';
}

// Chamado a cada 20s: manda os lembretes que venceram, marcando quem pediu.
export async function enviarLembretes(sock) {
    for (const l of b.lembretesVencidos()) {
        try {
            await sock.sendMessage(l.chat, { text: `⏰ *Lembrete* de @${l.autor.split('@')[0]}: ${l.texto}`, mentions: [l.autor] });
            b.marcarLembrete(l.id);
        } catch (e) {
            console.error('Lembrete:', e.message);
            return;
        }
    }
}
