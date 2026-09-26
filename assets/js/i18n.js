/**
 * i18n — Arabic (default) and English, with full RTL/LTR switching.
 *
 * The chess notation stays latin in both languages: "Nf3" is "Nf3" in Arabic
 * chess apps too. Only the interface words are translated.
 *
 * @author DALI951
 */
export const STRINGS = {
  ar: {
    dir: 'rtl',
    htmlLang: 'ar',
    brand: 'كرسات',
    docTitle: 'كرسات — شطرنج',
    skipToBoard: 'تخطَّ إلى الرقعة',
    navPlay: 'العب', navPuzzles: 'ألغاز', navLeaderboard: 'المتصدرون',
    tabGame: 'اللعبة', tabMoves: 'الحركات', tabSetup: 'الإعدادات',
    lblMode: 'الوضع', modeAi: 'ضد الحاسوب', modeDuo: 'لاعبان على نفس الجهاز',
    lblTime: 'الوقت', lblLevel: 'مستوى الحاسوب', lblColor: 'ألوانك',
    colorWhite: 'أبيض', colorBlack: 'أسود', colorRandom: 'عشوائي',
    btnNewGame: 'لعبة جديدة', btnUndo: 'تراجع', btnFlip: 'قلب', btnResign: 'استسلام',
    btnCopyPgn: 'نسخ PGN', btnCopyFen: 'نسخ FEN',
    statMoves: 'الحركات', statEval: 'التقييم',
    lblFen: 'موقف مخصص (FEN)', hintFen: 'اتركه فارغًا للعبة جديدة من البداية.',
    btnLoadFen: 'تحميل', btnClearFen: 'مسح',
    noteSoon: 'الحسابات واللعب عبر الإنترنت في المرحلة التالية.',
    footTag: 'محرك القواعد مُختبَر بـ ٦٨ مليون عقدة، و PHP يطابقه حرفًا بحرف.',
    you: 'أنت', engine: 'الحاسوب', white: 'أبيض', black: 'أسود',
    thinking: 'يفكّر…', yourTurn: 'دورك', opponentTurn: 'دور الخصم',
    win: 'فزت', lose: 'خسرت', draw: 'تعادل',
    resultCheckmate: 'خطأ الملك',
    resultStalemate: ' stalemate', // replaced below
    promoTitle: 'اختر القطعة',
    resigned: 'استسلم',
    newGameTitle: 'لعبة جديدة',
    drawOffer: 'عرض تعادل',
    accepted: 'مقبول', declined: 'مرفوض',
    sideWhite: 'أبيض', sideBlack: 'أسود',
    copyOk: 'تم النسخ', copyFail: 'فشل النسخ',
    check: 'كش!', checkSuffix: '',
  },
  en: {
    dir: 'ltr',
    htmlLang: 'en',
    brand: 'KERSAT',
    docTitle: 'Kersat — Chess',
    skipToBoard: 'Skip to board',
    navPlay: 'Play', navPuzzles: 'Puzzles', navLeaderboard: 'Leaderboard',
    tabGame: 'Game', tabMoves: 'Moves', tabSetup: 'Settings',
    lblMode: 'Mode', modeAi: 'vs Computer', modeDuo: 'Two players',
    lblTime: 'Time', lblLevel: 'Engine level', lblColor: 'Your colour',
    colorWhite: 'White', colorBlack: 'Black', colorRandom: 'Random',
    btnNewGame: 'New game', btnUndo: 'Undo', btnFlip: 'Flip', btnResign: 'Resign',
    btnCopyPgn: 'Copy PGN', btnCopyFen: 'Copy FEN',
    statMoves: 'Moves', statEval: 'Eval',
    lblFen: 'Custom position (FEN)', hintFen: 'Leave empty to start from the beginning.',
    btnLoadFen: 'Load', btnClearFen: 'Clear',
    noteSoon: 'Accounts and online play come in the next phase.',
    footTag: 'Rules engine proven over 68M nodes, matched move-for-move by PHP.',
    you: 'You', engine: 'Computer', white: 'White', black: 'Black',
    thinking: 'Thinking…', yourTurn: 'Your move', opponentTurn: 'Opponent to move',
    win: 'You win', lose: 'You lose', draw: 'Draw',
    resultCheckmate: 'Checkmate', resultStalemate: 'Stalemate',
    promoTitle: 'Promote to',
    resigned: 'Resigned',
    newGameTitle: 'New game',
    drawOffer: 'Draw offered', accepted: 'accepted', declined: 'declined',
    sideWhite: 'White', sideBlack: 'Black',
    copyOk: 'Copied', copyFail: 'Copy failed',
    check: 'Check!', checkSuffix: '',
  },
};

const LS_KEY = 'chess.lang';

export function loadLang() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved === 'ar' || saved === 'en') return saved;
  return (navigator.language || '').startsWith('ar') ? 'ar' : 'en';
}

export function applyLang(lang) {
  const s = STRINGS[lang];
  document.documentElement.lang = s.htmlLang;
  document.documentElement.dir = s.dir;
  document.title = s.docTitle;

  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (s[key] != null) el.textContent = s[key];
  }
  // the language button always shows the OTHER language
  const btn = document.getElementById('langToggle');
  btn.querySelector('#langLabel').textContent = lang === 'ar' ? 'EN' : 'ع';
  btn.lang = lang === 'ar' ? 'en' : 'ar';
  document.getElementById('brandName').textContent = s.brand;
  document.getElementById('brandName').lang = lang === 'ar' ? 'ar' : 'en';

  localStorage.setItem(LS_KEY, lang);
  return s;
}

export const t = (lang, key) => STRINGS[lang][key] ?? key;
