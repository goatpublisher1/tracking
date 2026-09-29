// =====================================================================
//  geo.js — normalização no formato que a Meta exige ANTES do sha256.
//  Sem isto, ct/st/country sao enviados, contam como preenchidos no
//  relatorio de qualidade de correspondencia, e nao casam com nada.
// =====================================================================

const semAcento = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const UF = {
  acre:'ac', alagoas:'al', amapa:'ap', amazonas:'am', bahia:'ba', ceara:'ce',
  distritofederal:'df', espiritosanto:'es', goias:'go', maranhao:'ma',
  matogrosso:'mt', matogrossodosul:'ms', minasgerais:'mg', para:'pa',
  paraiba:'pb', parana:'pr', pernambuco:'pe', piaui:'pi', riodejaneiro:'rj',
  riograndedonorte:'rn', riograndedosul:'rs', rondonia:'ro', roraima:'rr',
  santacatarina:'sc', saopaulo:'sp', sergipe:'se', tocantins:'to',
};

// minusculas, sem acento, sem espaco e sem pontuacao
function normCidade(v) {
  if (!v) return undefined;
  const out = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  return out || undefined;
}

// sigla de 2 letras minuscula; aceita nome por extenso
function normEstado(v) {
  if (!v) return undefined;
  const k = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  if (k.length === 2) return k;
  return UF[k] || undefined;
}

// ISO-3166 alpha-2 minusculo. Aceita sigla de 2, ISO-3 e o nome por extenso nos
// idiomas em que as plataformas mandam (PayT: pt; Digistore24: en). Desconhecido
// fica ausente — a Meta diz que campo errado e pior que campo faltando.
const PAIS = {
  br:'br', bra:'br', brasil:'br', brazil:'br',
  us:'us', usa:'us', unitedstates:'us', unitedstatesofamerica:'us', estadosunidos:'us', eua:'us',
  ca:'ca', can:'ca', canada:'ca',
  gb:'gb', gbr:'gb', uk:'gb', unitedkingdom:'gb', reinounido:'gb', greatbritain:'gb',
  au:'au', aus:'au', australia:'au',
  pt:'pt', prt:'pt', portugal:'pt',
  es:'es', esp:'es', spain:'es', espanha:'es', espana:'es',
  mx:'mx', mex:'mx', mexico:'mx',
  de:'de', deu:'de', germany:'de', alemanha:'de', deutschland:'de',
  fr:'fr', fra:'fr', france:'fr', franca:'fr',
  it:'it', ita:'it', italy:'it', italia:'it',
  ie:'ie', irl:'ie', ireland:'ie', irlanda:'ie',
  nz:'nz', nzl:'nz', newzealand:'nz', novazelandia:'nz',
  ar:'ar', arg:'ar', argentina:'ar',
  cl:'cl', chl:'cl', chile:'cl',
  co:'co', col:'co', colombia:'co',
};

function normPais(v) {
  if (!v) return undefined;
  const k = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return undefined;
  if (PAIS[k]) return PAIS[k];
  // sigla de 2 letras que nao esta na tabela: e ISO-2 valido na pratica
  // (a Meta so exige o formato), entao passa.
  if (k.length === 2) return k;
  return undefined;
}

// E.164 sem '+': a Meta exige o codigo do pais. Numero BR de 10-11 digitos
// (DDD + numero) recebe o 55 na frente.
function normTelefone(v) {
  if (!v) return undefined;
  let d = String(v).replace(/\D/g, '');
  if (!d) return undefined;
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

module.exports = { normCidade, normEstado, normPais, normTelefone };
