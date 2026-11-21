// Avisa no grupo quando a Epic Games Store libera jogo grátis (API pública da loja, não oficial).
import * as b from './bancos.js';
import config from './config.js';

const URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=pt-BR&country=BR&allowCountries=BR';

// Jogos 100% grátis agora (preço com desconto = 0 e promoção ativa)
function gratisAgora(data, agora = Date.now()) {
    const itens = data?.data?.Catalog?.searchStore?.elements || [];
    return itens.flatMap(el => {
        const promo = (el.promotions?.promotionalOffers || []).flatMap(p => p.promotionalOffers || [])
            .find(o => Date.parse(o.startDate) <= agora && agora < Date.parse(o.endDate));
        if (!promo || el.price?.totalPrice?.discountPrice !== 0) return [];
        const slug = el.catalogNs?.mappings?.[0]?.pageSlug || el.offerMappings?.[0]?.pageSlug || el.productSlug;
        const imagem = (el.keyImages || []).find(i => i.type === 'OfferImageWide') || (el.keyImages || []).find(i => i.type === 'Thumbnail');
        return [{
            id: el.id, titulo: el.title, fim: promo.endDate,
            link: slug ? `https://store.epicgames.com/pt-BR/p/${slug.replace(/\/home$/, '')}` : 'https://store.epicgames.com/pt-BR/free-games',
            imagem: imagem?.url
        }];
    });
}

export async function buscarGratis() {
    const res = await fetch(URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Epic respondeu ${res.status}`);
    return gratisAgora(await res.json());
}

const fmtFim = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const textoGratis = g => `🎁 *Jogo grátis na Epic:* ${g.titulo}\nResgata até ${fmtFim(g.fim)}: ${g.link}`;

export async function verificarEpic(sock) {
    const hora = new Date().getHours();
    if (!config.grupoId || hora < 9 || hora >= 22) return;   // não manda aviso de madrugada
    for (const g of await buscarGratis()) {
        const chave = `epic_${g.id}_${g.fim}`;
        if (b.getEstado(chave)) continue;
        const texto = textoGratis(g);
        if (g.imagem) {
            await sock.sendMessage(config.grupoId, { image: { url: g.imagem }, caption: texto })
                .catch(() => sock.sendMessage(config.grupoId, { text: texto }));
        } else {
            await sock.sendMessage(config.grupoId, { text: texto });
        }
        b.setEstado(chave, new Date().toISOString());
        console.log(`🎁 Jogo grátis avisado: ${g.titulo}`);
    }
}
