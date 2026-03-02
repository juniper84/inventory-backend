export type PlaybookLocale = 'en' | 'sw';

export type PlaybookConfidence = 'high' | 'medium' | 'low';

export type SupportChatPlaybook = {
  error_code: string;
  modules?: string[];
  routes?: string[];
  title: Record<PlaybookLocale, string>;
  diagnosis: Record<PlaybookLocale, string>;
  likely_cause: Record<PlaybookLocale, string>;
  steps: Record<PlaybookLocale, string[]>;
  related_routes: string[];
  confidence: PlaybookConfidence;
};

export const SUPPORT_CHAT_PLAYBOOKS: SupportChatPlaybook[] = [
  {
    error_code: 'CATEGORYID_IS_REQUIRED',
    modules: ['catalog'],
    routes: ['/{locale}/catalog/products', '/{locale}/catalog/products/wizard'],
    title: {
      en: 'Product requires a category',
      sw: 'Bidhaa inahitaji kategoria',
    },
    diagnosis: {
      en: 'Product creation failed because category was not selected.',
      sw: 'Uundaji wa bidhaa umeshindwa kwa sababu kategoria haikuchaguliwa.',
    },
    likely_cause: {
      en: 'No category exists yet, or form was submitted without categoryId.',
      sw: 'Hakuna kategoria iliyopo bado, au fomu ilitumwa bila categoryId.',
    },
    steps: {
      en: [
        'Open Catalog - Categories and create at least one active category.',
        'Return to Catalog - Products and select the category before submit.',
        'Retry product save and confirm success response.',
      ],
      sw: [
        'Fungua Katalogi - Kategoria na unda angalau kategoria moja ACTIVE.',
        'Rudi Katalogi - Bidhaa na chagua kategoria kabla ya kutuma.',
        'Jaribu kuhifadhi bidhaa tena na thibitisha imekubaliwa.',
      ],
    },
    related_routes: ['/{locale}/catalog/categories', '/{locale}/catalog/products'],
    confidence: 'high',
  },
  {
    error_code: 'AN_OPEN_SHIFT_IS_REQUIRED_FOR_POS_SALES',
    modules: ['sales-pos', 'business-settings'],
    routes: ['/{locale}/pos', '/{locale}/shifts'],
    title: {
      en: 'Open shift is required',
      sw: 'Zamu iliyo wazi inahitajika',
    },
    diagnosis: {
      en: 'POS completion is blocked because no OPEN shift exists for the branch.',
      sw: 'Ukamilishaji wa POS umefungwa kwa sababu hakuna zamu OPEN ya tawi hilo.',
    },
    likely_cause: {
      en: 'Shift tracking is enabled and cashier has not opened shift.',
      sw: 'Ufuatiliaji wa zamu umewashwa na mshika fedha hajafungua zamu.',
    },
    steps: {
      en: [
        'Open the Shifts page for the active branch.',
        'Create/open a shift with opening cash.',
        'Return to POS and retry completion.',
      ],
      sw: [
        'Fungua ukurasa wa Shifts kwa tawi husika.',
        'Fungua zamu kwa kuweka opening cash.',
        'Rudi POS na ujaribu kukamilisha mauzo tena.',
      ],
    },
    related_routes: ['/{locale}/shifts', '/{locale}/pos'],
    confidence: 'high',
  },
  {
    error_code: 'CREDIT_SALES_REQUIRE_PERMISSION',
    modules: ['sales-pos', 'user-access'],
    routes: ['/{locale}/pos', '/{locale}/settings/roles'],
    title: {
      en: 'Missing credit sale permission',
      sw: 'Ruhusa ya mauzo ya mkopo haipo',
    },
    diagnosis: {
      en: 'Credit sale flow was attempted without required permission.',
      sw: 'Mtiririko wa mauzo ya mkopo umejaribiwa bila ruhusa inayotakiwa.',
    },
    likely_cause: {
      en: 'User role is missing sales.credit.create.',
      sw: 'Jukumu la mtumiaji halina sales.credit.create.',
    },
    steps: {
      en: [
        'Use full-payment checkout for now, or',
        'Ask admin to grant credit-sale permission on Roles page.',
        'Retry the credit sale once permission is updated.',
      ],
      sw: [
        'Tumia malipo kamili kwa sasa, au',
        'Omba admin aongeze ruhusa ya mauzo ya mkopo kwenye Roles.',
        'Jaribu tena mauzo ya mkopo baada ya ruhusa kusasishwa.',
      ],
    },
    related_routes: ['/{locale}/settings/roles', '/{locale}/pos'],
    confidence: 'high',
  },
  {
    error_code: 'INSUFFICIENT_STOCK_FOR_SALE',
    modules: ['sales-pos', 'stock'],
    routes: ['/{locale}/pos', '/{locale}/stock'],
    title: {
      en: 'Stock is not enough for this sale',
      sw: 'Hisa haitoshi kwa mauzo haya',
    },
    diagnosis: {
      en: 'Requested quantity exceeds available branch stock.',
      sw: 'Kiasi kilichoombwa kimezidi hisa iliyopo kwenye tawi.',
    },
    likely_cause: {
      en: 'On-hand stock is low, variant is wrong, or branch context is incorrect.',
      sw: 'Hisa iliyopo ni ndogo, variant si sahihi, au muktadha wa tawi si sahihi.',
    },
    steps: {
      en: [
        'Check variant and quantity in POS cart.',
        'Open Stock page and verify branch-level on-hand.',
        'Adjust quantity or replenish stock, then retry.',
      ],
      sw: [
        'Kagua variant na kiasi kwenye kikapu cha POS.',
        'Fungua ukurasa wa Stock na hakiki hisa ya tawi husika.',
        'Punguza kiasi au ongeza hisa, kisha jaribu tena.',
      ],
    },
    related_routes: ['/{locale}/stock', '/{locale}/pos'],
    confidence: 'high',
  },
  {
    error_code: 'PAYMENT_METHOD_REQUIRED',
    modules: ['sales-pos'],
    routes: ['/{locale}/pos'],
    title: {
      en: 'Payment method is missing',
      sw: 'Njia ya malipo haijachaguliwa',
    },
    diagnosis: {
      en: 'Sale completion was submitted without payment method selection.',
      sw: 'Ukamilishaji wa mauzo umetumwa bila kuchagua njia ya malipo.',
    },
    likely_cause: {
      en: 'Checkout form is incomplete for non-credit sale.',
      sw: 'Fomu ya checkout haijakamilika kwa mauzo yasiyo ya mkopo.',
    },
    steps: {
      en: [
        'Open payment section in POS checkout.',
        'Select valid payment method and amount.',
        'Submit completion again.',
      ],
      sw: [
        'Fungua sehemu ya malipo kwenye checkout ya POS.',
        'Chagua njia sahihi ya malipo na kiasi.',
        'Tuma ukamilishaji tena.',
      ],
    },
    related_routes: ['/{locale}/pos'],
    confidence: 'high',
  },
  {
    error_code: 'BRANCH_SCOPED_ROLE_RESTRICTION',
    title: {
      en: 'Branch scope restriction',
      sw: 'Kizuizi cha wigo wa tawi',
    },
    diagnosis: {
      en: 'Action targets a branch outside your assigned branch scope.',
      sw: 'Hatua inalenga tawi lililo nje ya wigo wa matawi uliyopewa.',
    },
    likely_cause: {
      en: 'Your role is branch-scoped and selected branch is not allowed.',
      sw: 'Jukumu lako lina wigo wa matawi na tawi lililochaguliwa haliruhusiwi.',
    },
    steps: {
      en: [
        'Switch to an allowed branch if available.',
        'Ask admin to update your branch scope in role assignment.',
        'Retry the action within permitted branch.',
      ],
      sw: [
        'Badilisha kwenda tawi linaloruhusiwa kama lipo.',
        'Omba admin asasishe branch scope kwenye role assignment yako.',
        'Jaribu tena hatua ndani ya tawi linaloruhusiwa.',
      ],
    },
    related_routes: ['/{locale}/settings/users', '/{locale}/settings/roles'],
    confidence: 'high',
  },
  {
    error_code: 'PURCHASE_ORDER_LINES_ARE_REQUIRED',
    modules: ['purchases-suppliers'],
    routes: ['/{locale}/purchase-orders', '/{locale}/purchase-orders/wizard'],
    title: {
      en: 'Purchase order lines are missing',
      sw: 'Mistari ya oda ya manunuzi haipo',
    },
    diagnosis: {
      en: 'Purchase order submit failed because no lines were provided.',
      sw: 'Kutuma oda ya manunuzi kumeshindwa kwa sababu hakuna mistari iliyowekwa.',
    },
    likely_cause: {
      en: 'Supplier selected but item list is empty.',
      sw: 'Supplier amechaguliwa lakini orodha ya bidhaa ni tupu.',
    },
    steps: {
      en: [
        'Add at least one valid line item (variant, quantity, unit cost).',
        'Verify duplicate lines are not present.',
        'Submit purchase order again.',
      ],
      sw: [
        'Ongeza angalau mstari mmoja sahihi (variant, kiasi, bei ya kitengo).',
        'Thibitisha hakuna mistari inayojirudia.',
        'Tuma oda ya manunuzi tena.',
      ],
    },
    related_routes: ['/{locale}/purchase-orders', '/{locale}/purchase-orders/wizard'],
    confidence: 'high',
  },
  {
    error_code: 'RECEIVING_OVERRIDE_REQUIRES_A_REASON',
    modules: ['receiving-returns'],
    routes: ['/{locale}/receiving'],
    title: {
      en: 'Receiving override requires reason',
      sw: 'Override ya receiving inahitaji sababu',
    },
    diagnosis: {
      en: 'Receiving override was attempted without a reason.',
      sw: 'Override ya receiving imejaribiwa bila sababu.',
    },
    likely_cause: {
      en: 'Override toggle was used but reason field was left empty.',
      sw: 'Chaguo la override limetumika lakini sehemu ya sababu imeachwa tupu.',
    },
    steps: {
      en: [
        'Enter clear reason in receiving override field.',
        'Confirm lines still match purchase intent.',
        'Resubmit receiving.',
      ],
      sw: [
        'Weka sababu iliyo wazi kwenye sehemu ya receiving override.',
        'Thibitisha mistari bado inaendana na lengo la manunuzi.',
        'Tuma receiving tena.',
      ],
    },
    related_routes: ['/{locale}/receiving'],
    confidence: 'high',
  },
  {
    error_code: 'RECEIVING_IS_NOT_ALLOWED_IN_OFFLINE_MODE',
    modules: ['receiving-returns', 'offline-sync'],
    routes: ['/{locale}/receiving', '/{locale}/offline'],
    title: {
      en: 'Receiving cannot run in offline mode',
      sw: 'Receiving hairuhusiwi kwenye offline mode',
    },
    diagnosis: {
      en: 'Receiving endpoint blocked because system is in offline write mode.',
      sw: 'Endpoint ya receiving imezuiwa kwa sababu mfumo uko kwenye offline write mode.',
    },
    likely_cause: {
      en: 'Device/session is currently offline.',
      sw: 'Kifaa au kikao kiko nje ya mtandao kwa sasa.',
    },
    steps: {
      en: [
        'Reconnect to network and resume online mode.',
        'Sync pending offline queue if required.',
        'Retry receiving operation.',
      ],
      sw: [
        'Unganisha mtandao tena na urejee hali ya online.',
        'Fanya sync ya foleni ya offline kama inahitajika.',
        'Jaribu receiving tena.',
      ],
    },
    related_routes: ['/{locale}/offline', '/{locale}/receiving'],
    confidence: 'high',
  },
  {
    error_code: 'VARIANT_NOT_ON_PURCHASE_ORDER',
    modules: ['receiving-returns', 'purchases-suppliers'],
    routes: ['/{locale}/receiving', '/{locale}/purchase-orders'],
    title: {
      en: 'Variant is not part of purchase order',
      sw: 'Variant haipo kwenye oda ya manunuzi',
    },
    diagnosis: {
      en: 'Receiving line references variant that is not listed on source purchase order.',
      sw: 'Mstari wa receiving unatumia variant ambayo haipo kwenye purchase order husika.',
    },
    likely_cause: {
      en: 'Wrong variant selected or purchase order reference mismatch.',
      sw: 'Variant isiyo sahihi imechaguliwa au rejea ya purchase order haijalingana.',
    },
    steps: {
      en: [
        'Open purchase order and confirm expected variants.',
        'Correct receiving line to matching variant.',
        'Retry receiving submit.',
      ],
      sw: [
        'Fungua purchase order na hakiki variant zinazotarajiwa.',
        'Sahihisha mstari wa receiving kwa variant inayolingana.',
        'Jaribu kutuma receiving tena.',
      ],
    },
    related_routes: ['/{locale}/purchase-orders', '/{locale}/receiving'],
    confidence: 'high',
  },
];

