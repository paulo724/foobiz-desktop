// Interpreta os códigos do spooler do Windows (PRINTER_INFO_2 / JOB_INFO_1).
// Sem dependência de koffi para poder ser testado fora do Windows.

// PRINTER_STATUS_* (winspool.h)
const PRINTER_PROBLEMS = [
  [0x00000080, 'Impressora offline'],
  [0x00001000, 'Impressora indisponível'],
  [0x00000010, 'Sem papel'],
  [0x00000008, 'Papel atolado'],
  [0x00000040, 'Problema no papel'],
  [0x00400000, 'Tampa aberta'],
  [0x00100000, 'Impressora requer intervenção'],
  [0x00000002, 'Impressora em erro'],
  [0x00000001, 'Impressora pausada no Windows'],
  [0x00000004, 'Impressora sendo removida do Windows'],
  [0x00800000, 'Estado da impressora desconhecido'],
]
const PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400

// JOB_STATUS_* (winspool.h)
const JOB_PROBLEMS = [
  [0x00000020, 'Impressora offline'],
  [0x00000040, 'Sem papel'],
  [0x00000400, 'Impressora requer intervenção'],
  [0x00000200, 'Impressora bloqueada'],
  [0x00000002, 'Erro no trabalho'],
  [0x00000001, 'Trabalho pausado'],
  [0x00000004, 'Trabalho sendo cancelado'],
  [0x00000100, 'Trabalho cancelado'],
]
const JOB_DONE = 0x00000080 | 0x00001000 // PRINTED | COMPLETE

function describePrinter({ status = 0, attributes = 0, jobs = 0 } = {}) {
  if (attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) {
    return { online: false, reason: 'Impressora marcada como "Usar impressora offline" no Windows', jobs }
  }
  const problem = PRINTER_PROBLEMS.find(([flag]) => status & flag)
  return problem ? { online: false, reason: problem[1], jobs } : { online: true, reason: null, jobs }
}

// info null = trabalho não existe mais na fila (concluído e removido pelo spooler).
function describeJob(info) {
  if (!info) return { state: 'done', reason: null }
  if (info.status & JOB_DONE) return { state: 'done', reason: null }
  const problem = JOB_PROBLEMS.find(([flag]) => info.status & flag)
  if (problem) return { state: 'error', reason: `${problem[1]} (trabalho continua na fila do Windows)` }
  return { state: 'pending', reason: null }
}

module.exports = { describePrinter, describeJob }
