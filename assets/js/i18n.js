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
    brand: 'شطرنجي',
    docTitle: 'شطرنجي — الشطرنج عبر الإنترنت',
    metaDesc: 'العب الشطرنج ضد الحاسوب أو ضد لاعبين حقيقيين. بالعربية والإنجليزية.',
    skipToBoard: 'تخطَّ إلى الرقعة',
    navPlay: 'العب', navPuzzles: 'ألغاز', navLeaderboard: 'المتصدرون',
    tabGame: 'اللعبة', tabMoves: 'الحركات', tabSetup: 'الإعدادات',
    lblMode: 'الوضع', modeAi: 'ضد الحاسوب', modeDuo: 'لاعبان على نفس الجهاز',
    modeOnline: 'عبر الإنترنت',
    lblTime: 'الوقت', lblLevel: 'مستوى الحاسوب', lblColor: 'ألوانك',
    timeUnlimited: 'بدون وقت', timeCustom: 'مخصص…',
    lblMinutes: 'الدقائق', lblIncrement: 'الزيادة (ثانية)',
    btnApply: 'تطبيق', customBad: 'أدخل عددًا أكبر من صفر',
    colorWhite: 'أبيض', colorBlack: 'أسود', colorRandom: 'عشوائي',
    btnNewGame: 'لعبة جديدة', btnUndo: 'تراجع', btnFlip: 'قلب', btnResign: 'استسلام',
    btnCopyPgn: 'نسخ PGN', btnCopyFen: 'نسخ FEN',
    statMoves: 'الحركات', statEval: 'التقييم',
    lblFen: 'موقف مخصص (FEN)', hintFen: 'اتركه فارغًا للعبة جديدة من البداية.',
    btnLoadFen: 'تحميل', btnClearFen: 'مسح',
    noteSetup: 'تحميل موقف محفوظ، ومشاركة رابط اللعبة، وتثبيت النتيجة.',
    // ── online ──────────────────────────────────────────────────────────────
    tabOnline: 'العب', onlineRoom: 'الغرفة', onlineJoinLabel: 'انضم بكود',
    onlineLinkLabel: 'رابط الدعوة', onlineWaiting: 'في انتظار خصم',
    onlineQuickWaiting: 'نبحث عن خصم. ستبدأ المباراة في اللحظة التي يبحث فيها لاعب آخر أيضاً.',
    onlineShareText: '{name} يلعب شطرنج. انضم إليه: {url}',
    onlinePlaying: 'جارية', onlineEnded: 'انتهت', onlineNobody: 'لا يوجد خصم بعد',
    onlineNeedCode: 'اكتب كود الغرفة', onlineDrawAsked: 'خصمك يطلب التعادل',
    needLogin: 'سجّل دخولك أولًا', slowDown: 'تمهّل قليلًا', offline: 'غير متصل',
    connectionProblem: 'تعذّر الاتصال بالخادم', resultAbandoned: 'تُركت دون تحرّك',
    resultAgreement: 'تعادل بالاتفاق', resultOther: 'انتهت اللعبة',
    resultTimeOther: 'انتهى وقت الخصم', resultTimeYou: 'انتهى وقتك',
    resignedOther: 'استسلام الخصم',
    btnJoin: 'انضم', btnCopy: 'نسخ', btnSend: 'أرسل', btnAccept: 'قبول',
    btnDecline: 'رفض', btnOfferDraw: 'اعرض التعادل', btnLeave: 'خروج',
      btnCreateRoom: 'غرفة جديدة', btnQuickMatch: 'لعب سريع', btnShare: 'مشاركة',
      btnTakeSeat: 'اجلس في هذه الغرفة', chatPlaceholder: 'اكتب رسالة…',
    authUser: 'اسم المستخدم', authDisplay: 'الاسم الظاهر', authPass: 'كلمة المرور',
    authRemember: 'أبقني مسجّلًا', btnLogin: 'دخول', btnRegister: 'حساب جديد', btnLogout: 'تسجيل الخروج',
    authWrong: 'اسم المستخدم أو كلمة المرور غير صحيحة', authFailed: 'تعذّر إتمام العملية',
    authFillBoth: 'اكتب اسم المستخدم وكلمة المرور',
    footTag: 'محرك القواعد مُختبَر بـ ٦٨ مليون عقدة، و PHP يطابقه حرفًا بحرف.',
    you: 'أنت', engine: 'الحاسوب', white: 'أبيض', black: 'أسود',
    thinking: 'يفكّر…', yourTurn: 'دورك', opponentTurn: 'دور الخصم',
    win: 'فزت', lose: 'خسرت', draw: 'تعادل',
    // result reasons. resultCheckmate used to be خطأ الملك ("the king's error"),
    // which is not what checkmate means, and resultStalemate was an English
    // leftover with a leading space: neither would have shipped.
    resultCheckmate: 'كش ملك',
    resultStalemate: 'لا توجد حركة قانونية',
    resultTimeWhite: 'انتهى وقت الأبيض',
    resultTimeBlack: 'انتهى وقت الأسود',
    resultThreefold: 'تكرّر الموقف ثلاث مرات',
    resultFifty: 'قاعدة الخمسين حركة',
    resultMaterial: 'القطع لا تكفي للنهاية',
    promoTitle: 'اختر القطعة',
    resigned: 'استسلم',
    engineError: 'تعذّر تشغيل المحرّك',
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
    brand: 'SHATRANGI',
    docTitle: 'Shatrangi — Play Chess Online',
    metaDesc: 'Play chess against the engine or real people. Arabic and English.',
    skipToBoard: 'Skip to board',
    navPlay: 'Play', navPuzzles: 'Puzzles', navLeaderboard: 'Leaderboard',
    tabGame: 'Game', tabMoves: 'Moves', tabSetup: 'Settings',
    lblMode: 'Mode', modeAi: 'vs Computer', modeDuo: 'Two players', modeOnline: 'Online',
    lblTime: 'Time', lblLevel: 'Engine level', lblColor: 'Your colour',
    timeUnlimited: 'No clock', timeCustom: 'Custom…',
    lblMinutes: 'Minutes', lblIncrement: 'Increment (sec)',
    btnApply: 'Apply', customBad: 'Enter a number above zero',
    colorWhite: 'White', colorBlack: 'Black', colorRandom: 'Random',
    btnNewGame: 'New game', btnUndo: 'Undo', btnFlip: 'Flip', btnResign: 'Resign',
    btnCopyPgn: 'Copy PGN', btnCopyFen: 'Copy FEN',
    statMoves: 'Moves', statEval: 'Eval',
    lblFen: 'Custom position (FEN)', hintFen: 'Leave empty to start from the beginning.',
    btnLoadFen: 'Load', btnClearFen: 'Clear',
    noteSetup: 'Load a saved position, share a game link, keep your rating.',
    // ── online ──────────────────────────────────────────────────────────────
    tabOnline: 'Play online', onlineRoom: 'Room', onlineJoinLabel: 'Join with a code',
    onlineLinkLabel: 'Challenge link', onlineWaiting: 'Waiting for an opponent',
    onlineQuickWaiting: 'Looking for an opponent. You will be paired the moment somebody else is looking too.',
    onlineShareText: '{name} is playing chess. Join them: {url}',
    onlinePlaying: 'In play', onlineEnded: 'Finished', onlineNobody: 'No opponent yet',
    onlineNeedCode: 'Type a room code', onlineDrawAsked: 'Your opponent offers a draw',
    needLogin: 'Log in first', slowDown: 'Slow down a moment', offline: 'offline',
    connectionProblem: 'Could not reach the server', resultAbandoned: 'Abandoned',
    resultAgreement: 'Draw by agreement', resultOther: 'The game is over',
    resultTimeOther: 'Your opponent ran out of time', resultTimeYou: 'You ran out of time',
    resignedOther: 'Your opponent resigned',
    btnJoin: 'Join', btnCopy: 'Copy', btnSend: 'Send', btnAccept: 'Accept',
    btnDecline: 'Decline', btnOfferDraw: 'Offer a draw', btnLeave: 'Leave',
    btnCreateRoom: 'New room', btnQuickMatch: 'Quick play', btnShare: 'Share',
    btnTakeSeat: 'Take this seat', chatPlaceholder: 'Write a message…',
    authUser: 'Username', authDisplay: 'Display name', authPass: 'Password',
    authRemember: 'Keep me signed in', btnLogin: 'Log in', btnRegister: 'Sign up', btnLogout: 'Log out',
    authWrong: 'Wrong username or password', authFailed: 'That did not work',
    authFillBoth: 'Enter a username and a password',
    footTag: 'Rules engine proven over 68M nodes, matched move-for-move by PHP.',
    you: 'You', engine: 'Computer', white: 'White', black: 'Black',
    thinking: 'Thinking…', yourTurn: 'Your move', opponentTurn: 'Opponent to move',
    win: 'You win', lose: 'You lose', draw: 'Draw',
    resultCheckmate: 'Checkmate',
    resultStalemate: 'No legal moves',
    resultTimeWhite: 'White ran out of time',
    resultTimeBlack: 'Black ran out of time',
    resultThreefold: 'Threefold repetition',
    resultFifty: 'Fifty-move rule',
    resultMaterial: 'Insufficient material',
    promoTitle: 'Promote to',
    resigned: 'Resigned',
    engineError: 'The engine could not start',
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
  document.querySelector('meta[name="description"]')?.setAttribute('content', s.metaDesc);

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
