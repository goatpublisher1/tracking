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

// ISO-3166 alpha-2 minusculo
function normPais(v) {
  if (!v) return undefined;
  const k = semAcento(v).toLowerCase().replace(/[^a-z]/g, '');
  if (k.length === 2) return k;
  if (k === 'brasil' || k === 'brazil') return 'br';
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
