// Normaliza nomes de clubes para uma chave única, porque cada fonte escreve de um jeito
// (football-data: "Atlético Mineiro", ESPN: "Atlético-MG", gente: "galo"...).
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const CLUBES = [
    ['atletico-mg', 'Atlético-MG', ['atletico mineiro', 'atletico-mg', 'atletico mg', 'atl mineiro', 'galo', 'cam']],
    ['athletico-pr', 'Athletico-PR', ['athletico', 'atletico-pr', 'atletico pr', 'atletico paranaense', 'ca paranaense', 'furacao', 'cap']],
    ['atletico-go', 'Atlético-GO', ['atletico goianiense', 'atletico-go', 'atletico go', 'dragao']],
    ['america-mg', 'América-MG', ['america mineiro', 'america-mg', 'america mg']],
    ['sao-paulo', 'São Paulo', ['sao paulo', 'spfc', 'tricolor paulista']],
    ['flamengo', 'Flamengo', ['flamengo', 'mengao', 'fla']],
    ['fluminense', 'Fluminense', ['fluminense', 'flu']],
    ['palmeiras', 'Palmeiras', ['palmeiras', 'verdao', 'porco']],
    ['corinthians', 'Corinthians', ['corinthians', 'timao']],
    ['santos', 'Santos', ['santos', 'peixe']],
    ['vasco', 'Vasco', ['vasco']],
    ['gremio', 'Grêmio', ['gremio']],
    ['inter-limeira', 'Inter de Limeira', ['inter de limeira']],
    ['internacional', 'Internacional', ['internacional', 'inter']],
    ['cruzeiro', 'Cruzeiro', ['cruzeiro', 'raposa']],
    ['bahia', 'Bahia', ['bahia']],
    ['vitoria', 'Vitória', ['vitoria']],
    ['fortaleza', 'Fortaleza', ['fortaleza']],
    ['ceara', 'Ceará', ['ceara']],
    ['bragantino', 'Bragantino', ['bragantino', 'red bull', 'massa bruta']],
    ['sport', 'Sport', ['sport recife', 'sport']],
    ['juventude', 'Juventude', ['juventude']],
    ['mirassol', 'Mirassol', ['mirassol']],
    ['goias', 'Goiás', ['goias']],
    ['vila-nova', 'Vila Nova', ['vila nova']],
    ['coritiba', 'Coritiba', ['coritiba', 'coxa']],
    ['cuiaba', 'Cuiabá', ['cuiaba']],
    ['chapecoense', 'Chapecoense', ['chapecoense', 'chape']],
    ['criciuma', 'Criciúma', ['criciuma']],
    ['remo', 'Remo', ['remo']],
    ['paysandu', 'Paysandu', ['paysandu']],
    ['novorizontino', 'Novorizontino', ['novorizontino']],
    ['avai', 'Avaí', ['avai']],
    // Série B e outros (para aviso de gol; o bolão continua só Série A)
    ['botafogo-sp', 'Botafogo-SP', ['botafogo-sp', 'botafogo sp', 'botafogo ribeirao']],
    ['operario-pr', 'Operário-PR', ['operario', 'operario-pr', 'operario pr', 'operario ferroviario']],
    ['amazonas', 'Amazonas', ['amazonas']],
    ['crb', 'CRB', ['crb']],
    ['csa', 'CSA', ['csa']],
    ['ferroviaria', 'Ferroviária', ['ferroviaria']],
    ['athletic-mg', 'Athletic-MG', ['athletic club', 'athletic-mg', 'athletic mg']],
    ['volta-redonda', 'Volta Redonda', ['volta redonda']],
    ['ponte-preta', 'Ponte Preta', ['ponte preta', 'ponte']],
    ['guarani', 'Guarani', ['guarani', 'bugre']],
    ['ituano', 'Ituano', ['ituano']],
    ['londrina', 'Londrina', ['londrina']],
    ['abc', 'ABC', ['abc']],
    ['nautico', 'Náutico', ['nautico', 'timbu']],
    ['santa-cruz', 'Santa Cruz', ['santa cruz']],
    ['brusque', 'Brusque', ['brusque']],
    ['tombense', 'Tombense', ['tombense']],
    ['ypiranga', 'Ypiranga', ['ypiranga']],
    ['botafogo-pb', 'Botafogo-PB', ['botafogo-pb', 'botafogo pb']],
    ['figueirense', 'Figueirense', ['figueirense']],
    ['confianca', 'Confiança', ['confianca']],
    ['sampaio-correa', 'Sampaio Corrêa', ['sampaio correa', 'sampaio']],
    ['parana', 'Paraná', ['parana clube']],
    ['portuguesa', 'Portuguesa', ['portuguesa']],
    ['ceilandia', 'Ceilândia', ['ceilandia']],
    ['brasiliense', 'Brasiliense', ['brasiliense']],
    ['aparecidense', 'Aparecidense', ['aparecidense']],
    ['anapolis', 'Anápolis', ['anapolis']],
    ['gama', 'Gama', ['gama']],
    ['botafogo', 'Botafogo', ['botafogo', 'fogao']]   // por último: depois de Botafogo-SP/PB
];

// Devolve { key, nome } ou null
export function identificarTime(texto) {
    const t = ` ${semAcento(texto).replace(/[^a-z0-9-]+/g, ' ').trim()} `;
    if (!t.trim()) return null;
    for (const [key, nome, apelidos] of CLUBES) {
        if (apelidos.some(a => t.includes(` ${a} `) || t.trim() === a || t.includes(` ${a}`) && a.length > 5)) {
            return { key, nome };
        }
    }
    return null;
}

export const listaTimes = () => CLUBES.map(([key, nome]) => ({ key, nome }));
