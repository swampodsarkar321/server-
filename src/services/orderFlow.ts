// COD order-taking flow: step-by-step collector (product → qty → name → phone → address → confirm).
// Short, formal prompts in Bangla or English based on the customer's language.

export type OrderStep = 'product' | 'qty' | 'name' | 'phone' | 'address' | 'confirm';

export interface OrderState {
  active: boolean;
  step: OrderStep;
  product: string;
  qty: number;
  name: string;
  phone: string;
  address: string;
  lang: 'bn' | 'en';
}

export const EMPTY_ORDER: OrderState = {
  active: false, step: 'product', product: '', qty: 1, name: '', phone: '', address: '', lang: 'bn',
};

const ORDER_RE = /(order|অর্ডার|কিনতে|কিনব|নিতে চাই|kinte|nite chai|buy|booking|বুকিং|cod|cash on delivery|ক্যাশ|ডেলিভারি|dam koto|দাম কত.*(নিব|চাই)|place.*order)/i;
const CANCEL_RE = /^(cancel|বাতিল|বাদ দাও|stop|থামো|na lagbe|লাগবে না)\.?$/i;
const YES_RE = /^(yes|yeah|ha|hyan|হ্যাঁ|জি|ok|confirm|কনফার্ম|thik|ঠিক)( ache)?\.?$/i;
const NO_RE = /^(no|na|না|nah)\.?$/i;

export function detectOrderIntent(text: string): boolean {
  return ORDER_RE.test(text);
}

export function isCancel(text: string): boolean {
  return CANCEL_RE.test(text.trim());
}

function langOf(text: string): 'bn' | 'en' {
  return /[\u0980-\u09FF]/.test(text) ? 'bn' : 'en';
}

const T = {
  bn: {
    askProduct: 'কোন প্রোডাক্টটি অর্ডার করতে চান? নামটি লিখুন।',
    askQty: (p: string) => `“${p}” — কয়টি নিতে চান? সংখ্যায় লিখুন।`,
    askName: 'আপনার নামটি লিখুন।',
    askPhone: 'মোবাইল নম্বরটি দিন (11 সংখ্যা, 01 দিয়ে শুরু)।',
    badPhone: 'নম্বরটি সঠিক মনে হচ্ছে না। 11 সংখ্যার মোবাইল নম্বর দিন (যেমন 01712345678)।',
    askAddress: 'ডেলিভারি ঠিকানা লিখুন (এলাকা, থানা, জেলা)।',
    confirm: (o: OrderState) =>
      `অর্ডারটি নিশ্চিত করুন:\n• পণ্য: ${o.product}\n• পরিমাণ: ${o.qty}\n• নাম: ${o.name}\n• মোবাইল: ${o.phone}\n• ঠিকানা: ${o.address}\nসঠিক হলে “হ্যাঁ” লিখুন, ভুল থাকলে “না” লিখুন।`,
    done: (id: string) => `ধন্যবাদ! আপনার অর্ডার নেওয়া হয়েছে (নম্বর: ${id})। ক্যাশ অন ডেলিভারিতে পণ্য পাঠানো হবে।`,
    restarted: 'ঠিক আছে, আবার শুরু করছি।',
    cancelled: 'অর্ডার বাতিল করা হয়েছে। অন্য কিছু জানতে চাইলে লিখুন।',
    badQty: 'পরিমাণ সংখ্যায় লিখুন (যেমন 2)।',
  },
  en: {
    askProduct: 'Which product would you like to order? Please write the name.',
    askQty: (p: string) => `“${p}” — how many? Reply with a number.`,
    askName: 'Please write your name.',
    askPhone: 'Please share your mobile number (11 digits, starts with 01).',
    badPhone: 'That number looks incorrect. Please give an 11-digit mobile number (e.g. 01712345678).',
    askAddress: 'Please write the delivery address (area, thana, district).',
    confirm: (o: OrderState) =>
      `Please confirm your order:\n• Product: ${o.product}\n• Qty: ${o.qty}\n• Name: ${o.name}\n• Mobile: ${o.phone}\n• Address: ${o.address}\nReply “yes” to confirm or “no” to restart.`,
    done: (id: string) => `Thank you! Your order is placed (no: ${id}). Pay cash on delivery.`,
    restarted: 'Okay, starting over.',
    cancelled: 'Order cancelled. Let me know if you need anything else.',
    badQty: 'Please write the quantity as a number (e.g. 2).',
  },
};

function normalizePhone(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  const m = digits.match(/(01\d{9})$/);
  return m ? m[1] : null;
}

export interface FlowResult {
  reply: string;
  state: OrderState;
  done: boolean;
  cancelled: boolean;
  order?: { product: string; qty: number; name: string; phone: string; address: string };
}

export function startOrder(firstText: string): { state: OrderState; reply: string } {
  const lang = langOf(firstText);
  // If the first message already names a product ("red kurti order korte chai"), keep it as context
  return { state: { ...EMPTY_ORDER, active: true, step: 'product', lang }, reply: T[lang].askProduct };
}

export function stepOrder(state: OrderState, text: string): FlowResult {
  const t = text.trim();
  const L = T[state.lang];
  if (isCancel(t)) {
    return { reply: L.cancelled, state: { ...EMPTY_ORDER }, done: false, cancelled: true };
  }
  const s = { ...state };
  switch (s.step) {
    case 'product': {
      if (t.length < 2) return { reply: L.askProduct, state: s, done: false, cancelled: false };
      s.product = t.slice(0, 120);
      s.step = 'qty';
      return { reply: L.askQty(s.product), state: s, done: false, cancelled: false };
    }
    case 'qty': {
      const n = parseInt(t.replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 1 || n > 100) return { reply: L.badQty, state: s, done: false, cancelled: false };
      s.qty = n;
      s.step = 'name';
      return { reply: L.askName, state: s, done: false, cancelled: false };
    }
    case 'name': {
      if (t.length < 2) return { reply: L.askName, state: s, done: false, cancelled: false };
      s.name = t.slice(0, 80);
      s.step = 'phone';
      return { reply: L.askPhone, state: s, done: false, cancelled: false };
    }
    case 'phone': {
      const p = normalizePhone(t);
      if (!p) return { reply: L.badPhone, state: s, done: false, cancelled: false };
      s.phone = p;
      s.step = 'address';
      return { reply: L.askAddress, state: s, done: false, cancelled: false };
    }
    case 'address': {
      if (t.length < 5) return { reply: L.askAddress, state: s, done: false, cancelled: false };
      s.address = t.slice(0, 300);
      s.step = 'confirm';
      return { reply: L.confirm(s), state: s, done: false, cancelled: false };
    }
    case 'confirm': {
      if (YES_RE.test(t.toLowerCase())) {
        const order = { product: s.product, qty: s.qty, name: s.name, phone: s.phone, address: s.address };
        return { reply: '', state: { ...EMPTY_ORDER }, done: true, cancelled: false, order };
      }
      // "no" or anything else → restart cleanly
      const fresh: OrderState = { ...EMPTY_ORDER, active: true, step: 'product', lang: s.lang };
      return { reply: `${L.restarted} ${L.askProduct}`, state: fresh, done: false, cancelled: false };
    }
  }
}

export function orderId(): string {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `ORD-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function isYesNo(text: string): boolean {
  const t = text.trim().toLowerCase();
  return YES_RE.test(t) || NO_RE.test(t);
}
