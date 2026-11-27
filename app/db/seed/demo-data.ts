/**
 * ВИГАДАНІ демонстраційні дані. Жодних реальних клієнтів: імена шаблонні,
 * email — у зарезервованих доменах example.com/example.org, адреси вигадані.
 * Кожне замовлення ілюструє певний сценарій перевірки даних.
 */

export interface DemoVariantSeed {
  key: string;
  title: string;
  sku: string;
  barcode: string;
  color: string | null;
  model: string | null;
  price: string;
  weightGrams: number | null;
  hsCode: string | null;
  countryOfOrigin: string | null;
  customsDescription: string | null;
  inventoryAvailable: number;
  /**
   * Етап 5: габарити одиниці в упаковці виробника, мм (довжина, ширина, висота) — для автоматичного підбору коробки.
   * Shopify габаритів не має (у робочому режимі їх вносять у розділі «Товари»). Частина демо-варіантів НАВМИСНО без
   * габаритів: видно і точний підбір («за габаритами й вагою»), і неточний (частково / лише за вагою → типова упаковка).
   */
  dimsMm?: [number, number, number];
}

export interface DemoProductSeed {
  key: string;
  title: string;
  handle: string;
  imageUrl: string;
  variants: DemoVariantSeed[];
}

export const DEMO_PRODUCTS: DemoProductSeed[] = [
  {
    key: "holder",
    title: "Тримач телефону Pro",
    handle: "phone-holder-pro",
    imageUrl: "/demo-images/phone-holder.svg",
    variants: [
      { key: "holder-black", title: "Чорний", sku: "OT-PH-BLK", barcode: "4820000000017", color: "Чорний", model: null, price: "29.00", weightGrams: 120, hsCode: "8714.10", countryOfOrigin: "UA", customsDescription: "Phone holder for electric scooter", inventoryAvailable: 42 },
      { key: "holder-white", title: "Білий", sku: "OT-PH-WHT", barcode: "4820000000024", color: "Білий", model: null, price: "29.00", weightGrams: 120, hsCode: "8714.10", countryOfOrigin: "UA", customsDescription: "Phone holder for electric scooter", inventoryAvailable: 7, dimsMm: [160, 90, 45] },
    ],
  },
  {
    key: "fender",
    title: "Крило заднє",
    handle: "rear-fender",
    imageUrl: "/demo-images/fender.svg",
    variants: [
      { key: "fender-x", title: "Model X", sku: "OT-FK-X", barcode: "4820000000031", color: null, model: "Model X", price: "34.50", weightGrams: 350, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Rear fender for electric scooter", inventoryAvailable: 18 },
      { key: "fender-s", title: "Model S", sku: "OT-FK-S", barcode: "4820000000048", color: null, model: "Model S", price: "34.50", weightGrams: 340, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Rear fender for electric scooter", inventoryAvailable: 3, dimsMm: [280, 140, 60] },
    ],
  },
  {
    key: "grips",
    title: "Грипси силіконові",
    handle: "silicone-grips",
    imageUrl: "/demo-images/grips.svg",
    variants: [
      { key: "grips-black", title: "Чорні", sku: "OT-GR-BLK", barcode: "4820000000055", color: "Чорний", model: null, price: "14.90", weightGrams: 90, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Silicone handlebar grips", inventoryAvailable: 60 },
      { key: "grips-gray", title: "Сірі", sku: "OT-GR-GRY", barcode: "4820000000062", color: "Сірий", model: null, price: "14.90", weightGrams: 90, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Silicone handlebar grips", inventoryAvailable: 25, dimsMm: [130, 40, 40] },
    ],
  },
  {
    key: "bag",
    title: "Сумка на кермо Mini",
    handle: "handlebar-bag-mini",
    imageUrl: "/demo-images/bag.svg",
    variants: [
      { key: "bag-black", title: "Чорна", sku: "OT-BG-BLK", barcode: "4820000000079", color: "Чорний", model: null, price: "39.00", weightGrams: 250, hsCode: "420292", countryOfOrigin: "UA", customsDescription: "Textile handlebar bag", inventoryAvailable: 12 },
    ],
  },
  {
    key: "light",
    title: "Комплект світла LED",
    handle: "led-light-set",
    imageUrl: "/demo-images/light.svg",
    variants: [
      { key: "light-std", title: "Стандарт", sku: "OT-LT-STD", barcode: "4820000000086", color: null, model: null, price: "24.90", weightGrams: 180, hsCode: "851210", countryOfOrigin: "UA", customsDescription: "LED lighting set for scooter", inventoryAvailable: 30 },
    ],
  },
  {
    key: "tire",
    title: "Покришка 10x2.5",
    handle: "tire-10x25",
    imageUrl: "/demo-images/tire.svg",
    variants: [
      // Навмисно без HS-коду та митного опису — демонструє проблему з даними товару.
      { key: "tire-std", title: "Стандарт", sku: "OT-TR-1025", barcode: "4820000000093", color: null, model: "10x2.5", price: "27.00", weightGrams: 900, hsCode: null, countryOfOrigin: "UA", customsDescription: null, inventoryAvailable: 9 },
    ],
  },
];

/**
 * Етап 5: вигадані колекції (як колекції Shopify) і товари в них (ключі DEMO_PRODUCTS). Товар може бути в кількох
 * колекціях; покришка — лише в «Шини та колеса». Шаблони комплектації «на колекцію» — demo-warehouse.server.ts.
 */
export interface DemoCollectionSeed {
  key: string;
  title: string;
  handle: string;
  products: string[];
}

export const DEMO_COLLECTIONS: DemoCollectionSeed[] = [
  { key: "fenders", title: "Крила та захист", handle: "fenders-and-protection", products: ["fender"] },
  { key: "handlebar", title: "Аксесуари на кермо", handle: "handlebar-accessories", products: ["holder", "grips", "bag"] },
  { key: "wheels", title: "Шини та колеса", handle: "tires-and-wheels", products: ["tire"] },
  { key: "safety", title: "Світло та безпека", handle: "lights-and-safety", products: ["light", "fender"] },
];

export interface DemoOrderSeed {
  number: string;
  /** Скільки годин тому оформлено. */
  hoursAgo: number;
  scenario: string;
  email: string | null;
  contactPhone: string | null;
  shipping: {
    firstName: string | null;
    lastName: string | null;
    company?: string | null;
    address1: string | null;
    address2?: string | null;
    city: string | null;
    province?: string | null;
    postalCode: string | null;
    countryCode: string | null;
    phone: string | null;
  };
  items: { variant: string; quantity: number }[];
  shippingPaid: string;
  /** Історичні замовлення: довести до цього стану через сервіси під час заповнення. */
  history?: "waybill" | "delivered" | "cancelled";
  /** Етап 5: пріоритет відправлення (0 звичайний, 1 високий, 2 терміновий). */
  priority?: 0 | 1 | 2;
}

export const DEMO_ORDERS: DemoOrderSeed[] = [
  {
    number: "#1001", hoursAgo: 2, scenario: "clean",
    email: "lena.h@example.com", contactPhone: null,
    shipping: { firstName: "Lena", lastName: "Hoffmann", address1: "Musterstraße 12", city: "Berlin", postalCode: "10115", countryCode: "DE", phone: "+49 1512 3456789" },
    items: [{ variant: "holder-black", quantity: 1 }, { variant: "grips-black", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    number: "#1002", hoursAgo: 3, scenario: "autofix: 00-prefix phone + PL postal format",
    email: "marta.n@example.com", contactPhone: null,
    shipping: { firstName: "Marta", lastName: "Nowak", address1: "ul. Przykładowa 5/12", city: "Warszawa", postalCode: "00950", countryCode: "PL", phone: "0048 512 345 678" },
    items: [{ variant: "fender-x", quantity: 1 }], shippingPaid: "11.00",
  },
  {
    number: "#1003", hoursAgo: 4, scenario: "autofix: GB postcode spacing/case + national phone",
    email: "oliver.s@example.org", contactPhone: null,
    shipping: { firstName: "Oliver", lastName: "Smith", address1: "221 Example Street", city: "London", postalCode: "sw1a1aa", countryCode: "gb", phone: "07400 123456" },
    items: [{ variant: "bag-black", quantity: 1 }], shippingPaid: "14.00",
  },
  {
    number: "#1004", hoursAgo: 5, scenario: "problem: missing postal code (manual fix)",
    email: "camille.m@example.com", contactPhone: null,
    shipping: { firstName: "Camille", lastName: "Martin", address1: "12 Rue de l'Exemple", city: "Lyon", postalCode: null, countryCode: "FR", phone: "+33 6 12 34 56 78" },
    items: [{ variant: "holder-white", quantity: 2 }], shippingPaid: "12.00",
  },
  {
    number: "#1005", hoursAgo: 6, scenario: "problem: missing US state",
    email: "emily.j@example.com", contactPhone: null,
    shipping: { firstName: "Emily", lastName: "Johnson", address1: "1200 Example Ave", city: "Austin", province: null, postalCode: "73301", countryCode: "US", phone: "+1 202 555 0123" },
    items: [{ variant: "light-std", quantity: 1 }, { variant: "grips-gray", quantity: 2 }], shippingPaid: "19.00",
  },
  {
    number: "#1006", hoursAgo: 7, scenario: "problem: ambiguous phone (needs manager choice)",
    email: "giulia.r@example.com", contactPhone: null,
    shipping: { firstName: "Giulia", lastName: "Rossi", address1: "Via Esempio 8", city: "Milano", postalCode: "20121", countryCode: "IT", phone: "3612345678" },
    items: [{ variant: "fender-s", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    number: "#1007", hoursAgo: 9, scenario: "autofix: 00-prefix phone + NL postcode",
    email: "daan.v@example.org", contactPhone: null,
    shipping: { firstName: "Daan", lastName: "de Vries", address1: "Voorbeeldstraat 7", city: "Amsterdam", postalCode: "1012ab", countryCode: "NL", phone: "0031 6 12345678" },
    items: [{ variant: "grips-black", quantity: 1 }], shippingPaid: "11.00",
  },
  {
    number: "#1008", hoursAgo: 11, scenario: "problem: product missing HS code / customs description",
    email: "lucia.g@example.com", contactPhone: null,
    shipping: { firstName: "Lucía", lastName: "García", address1: "Calle Ejemplo 3", city: "Madrid", postalCode: "28013", countryCode: "ES", phone: "+34 612 34 56 78" },
    items: [{ variant: "tire-std", quantity: 2 }], shippingPaid: "18.00",
  },
  {
    number: "#1009", hoursAgo: 13, scenario: "clean: country without postal codes",
    email: "omar.h@example.com", contactPhone: null,
    shipping: { firstName: "Omar", lastName: "Haddad", address1: "Example Tower, Office 1203", city: "Dubai", postalCode: null, countryCode: "AE", phone: "+971 50 123 4567" },
    items: [{ variant: "holder-black", quantity: 1 }], shippingPaid: "22.00",
  },
  {
    number: "#1010", hoursAgo: 15, scenario: "problem: shipping to country disabled",
    email: "ivan.p@example.com", contactPhone: null,
    shipping: { firstName: "Ivan", lastName: "Petrov", address1: "Primernaya ul. 1", city: "Moskva", postalCode: "101000", countryCode: "RU", phone: "+7 912 345 67 89" },
    items: [{ variant: "light-std", quantity: 1 }], shippingPaid: "20.00",
  },
  {
    number: "#1011", hoursAgo: 18, scenario: "autofix: CA postal format",
    email: "noah.t@example.org", contactPhone: null,
    shipping: { firstName: "Noah", lastName: "Tremblay", address1: "100 Example Rd", city: "Ottawa", province: "ON", postalCode: "k1a0b1", countryCode: "CA", phone: "+1 613 555 0199" },
    items: [{ variant: "bag-black", quantity: 1 }], shippingPaid: "21.00",
  },
  {
    number: "#1012", hoursAgo: 20, scenario: "autofix: copy contact phone to shipping phone",
    email: "felix.w@example.com", contactPhone: "+49 170 1234567",
    shipping: { firstName: "Felix", lastName: "Wagner", address1: "Beispielweg 4", city: "München", postalCode: "80331", countryCode: "DE", phone: null },
    items: [{ variant: "fender-x", quantity: 1 }, { variant: "holder-white", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    number: "#1013", hoursAgo: 23, scenario: "problems: missing city + phone contains a letter",
    email: "elsa.l@example.com", contactPhone: null,
    shipping: { firstName: "Elsa", lastName: "Lindqvist", address1: "Exempelgatan 2", city: null, postalCode: "11122", countryCode: "SE", phone: "+46 70 123 45 6O" },
    items: [{ variant: "grips-gray", quantity: 1 }], shippingPaid: "13.00",
  },
  // Історичні замовлення (ілюструють подальші статуси).
  {
    number: "#0998", hoursAgo: 30, scenario: "history: test waybill created", history: "waybill", priority: 1,
    email: "jonas.k@example.com", contactPhone: null,
    shipping: { firstName: "Jonas", lastName: "Keller", address1: "Probegasse 9", city: "Wien", postalCode: "1010", countryCode: "AT", phone: "+43 664 1234567" },
    items: [{ variant: "light-std", quantity: 1 }], shippingPaid: "13.00",
  },
  {
    number: "#0997", hoursAgo: 120, scenario: "history: delivered", history: "delivered",
    email: "piotr.w@example.com", contactPhone: null,
    shipping: { firstName: "Piotr", lastName: "Wiśniewski", address1: "ul. Testowa 1", city: "Kraków", postalCode: "30-001", countryCode: "PL", phone: "+48 601 234 567" },
    items: [{ variant: "grips-black", quantity: 2 }], shippingPaid: "11.00",
  },
  {
    number: "#0996", hoursAgo: 72, scenario: "history: cancelled before handover", history: "cancelled",
    email: "chloe.b@example.com", contactPhone: null,
    shipping: { firstName: "Chloé", lastName: "Bernard", address1: "5 Avenue Exemple", city: "Paris", postalCode: "75001", countryCode: "FR", phone: "+33 6 98 76 54 32" },
    items: [{ variant: "holder-black", quantity: 1 }], shippingPaid: "12.00",
  },
];

/**
 * Етап 5: ВИГАДАНА історія продажів для аналітики складу — оплачені й уже доставлені замовлення за 6–85 днів до
 * заповнення (seed.server.ts seedDemoSalesHistory). Без неї в демо немає попереднього періоду (тренд), швидкості за
 * 30/90 днів, прогнозу вичерпання й рекомендацій партій. Як імпорт історії з Shopify: замовлення вже передане
 * перевізнику (без накладної застосунку) і доставлене — не потрапляє в чергу пакування, не резервується й не змінює
 * початкових залишків (облік відкриває лише відкриті замовлення).
 * Покупці — загальновідомі імена-заповнювачі (Joe Bloggs, John Doe, Max Mustermann, Fred Nurk…), email — у
 * зарезервованих доменах example.*, телефони — з діапазонів для вигаданих номерів (GB 07700 900xxx, US/CA 555-01xx,
 * AU 0491 570 xxx); для країн без підтвердженого діапазону (DE, FR, PL) — заповнювач із нулів (+49 000 0000001), який
 * не є дійсним номером (libphonenumber-js/max) і тому не може належати абонентові. Вулиці — «Example/Muster/Przykładowa».
 * Розрахунок (налаштування за замовчуванням: термін виробництва 30 днів, цільовий запас 60, округлення 10; разом із
 * відкритими демо-замовленнями):
 * - Сумка Mini чорна: 16 шт. за 30 днів, 30 за 90; доступно 12 → вистачить на ~22 дні (< 30) — «під ризиком», дата
 *   вичерпання, рекомендація 30 шт.; попередній період 8 → тренд угору;
 * - Крило Model X: 8 / 28; доступно 18 → ~67 днів, рекомендація 10 шт.; попередній період 12 → тренд униз;
 * - Тримач білий: 9 / 17; доступно 7 → ~23 дні — «під ризиком», але партія вже у виробництві (рекомендації немає);
 * - Грипси чорні — найпопулярніші (18 / 43), запасу 60 вистачає; решта — рівномірні продажі без ризику.
 * Дні — не на межах періодів (29/30, 59/60, 89/90), щоб перехід часу й година запуску не змінювали результат.
 */
export interface DemoSalesHistorySeed {
  number: string;
  /** Скільки днів тому оформлено (від моменту заповнення). */
  daysAgo: number;
  email: string;
  shipping: DemoOrderSeed["shipping"];
  items: { variant: string; quantity: number }[];
  shippingPaid: string;
}

export const DEMO_SALES_HISTORY: DemoSalesHistorySeed[] = [
  // Поточні 30 днів.
  {
    number: "#0995", daysAgo: 6, email: "joe.bloggs@example.org",
    shipping: { firstName: "Joe", lastName: "Bloggs", address1: "1 Example Road", city: "Leeds", postalCode: "LS1 1AA", countryCode: "GB", phone: "+44 7700 900001" },
    items: [{ variant: "bag-black", quantity: 2 }, { variant: "grips-black", quantity: 2 }, { variant: "holder-black", quantity: 1 }], shippingPaid: "14.00",
  },
  {
    number: "#0994", daysAgo: 9, email: "erika.mustermann@example.com",
    shipping: { firstName: "Erika", lastName: "Mustermann", address1: "Musterweg 5", city: "Köln", postalCode: "50667", countryCode: "DE", phone: "+49 000 0000002" },
    items: [{ variant: "holder-white", quantity: 2 }, { variant: "bag-black", quantity: 2 }], shippingPaid: "12.00",
  },
  {
    number: "#0993", daysAgo: 11, email: "john.doe@example.com",
    shipping: { firstName: "John", lastName: "Doe", address1: "100 Example Ave", city: "Springfield", province: "IL", postalCode: "62701", countryCode: "US", phone: "+1 202 555 0141" },
    items: [{ variant: "grips-black", quantity: 3 }, { variant: "fender-x", quantity: 2 }, { variant: "light-std", quantity: 1 }], shippingPaid: "19.00",
  },
  {
    number: "#0992", daysAgo: 13, email: "jane.bloggs@example.org",
    shipping: { firstName: "Jane", lastName: "Bloggs", address1: "22 Sample Lane", city: "Bristol", postalCode: "BS1 1AA", countryCode: "GB", phone: "+44 7700 900002" },
    items: [{ variant: "bag-black", quantity: 3 }, { variant: "holder-black", quantity: 2 }], shippingPaid: "14.00",
  },
  {
    number: "#0991", daysAgo: 16, email: "jean.dupont@example.com",
    shipping: { firstName: "Jean", lastName: "Dupont", address1: "8 Rue de l'Exemple", city: "Paris", postalCode: "75002", countryCode: "FR", phone: "+33 0 00 00 00 01" },
    items: [{ variant: "grips-black", quantity: 3 }, { variant: "grips-gray", quantity: 2 }, { variant: "holder-white", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    number: "#0990", daysAgo: 19, email: "jane.doe@example.com",
    shipping: { firstName: "Jane", lastName: "Doe", address1: "200 Sample St", city: "Springfield", province: "IL", postalCode: "62702", countryCode: "US", phone: "+1 202 555 0142" },
    items: [{ variant: "bag-black", quantity: 2 }, { variant: "fender-x", quantity: 2 }, { variant: "tire-std", quantity: 1 }], shippingPaid: "21.00",
  },
  {
    number: "#0989", daysAgo: 22, email: "fred.nurk@example.net",
    shipping: { firstName: "Fred", lastName: "Nurk", address1: "1 Example Street", city: "Sydney", province: "NSW", postalCode: "2000", countryCode: "AU", phone: "+61 491 570 156" },
    items: [{ variant: "grips-black", quantity: 3 }, { variant: "holder-white", quantity: 2 }, { variant: "holder-black", quantity: 2 }, { variant: "light-std", quantity: 1 }], shippingPaid: "22.00",
  },
  {
    number: "#0988", daysAgo: 25, email: "jan.kowalski@example.com",
    shipping: { firstName: "Jan", lastName: "Kowalski", address1: "ul. Przykładowa 10", city: "Poznań", postalCode: "61-001", countryCode: "PL", phone: "+48 000 000 001" },
    items: [{ variant: "bag-black", quantity: 3 }, { variant: "fender-x", quantity: 1 }, { variant: "fender-s", quantity: 1 }], shippingPaid: "11.00",
  },
  {
    number: "#0987", daysAgo: 27, email: "richard.roe@example.org",
    shipping: { firstName: "Richard", lastName: "Roe", address1: "50 Example Rd", city: "Toronto", province: "ON", postalCode: "M5V 1A1", countryCode: "CA", phone: "+1 613 555 0143" },
    items: [
      { variant: "grips-black", quantity: 3 }, { variant: "holder-white", quantity: 1 }, { variant: "holder-black", quantity: 2 },
      { variant: "bag-black", quantity: 2 }, { variant: "fender-x", quantity: 1 }, { variant: "light-std", quantity: 1 },
    ],
    shippingPaid: "21.00",
  },
  // Попередні 30 днів (для тренду).
  {
    number: "#0986", daysAgo: 33, email: "fred.bloggs@example.org",
    shipping: { firstName: "Fred", lastName: "Bloggs", address1: "5 Placeholder Close", city: "York", postalCode: "YO1 1AA", countryCode: "GB", phone: "+44 7700 900003" },
    items: [{ variant: "fender-x", quantity: 3 }, { variant: "grips-black", quantity: 3 }, { variant: "bag-black", quantity: 2 }, { variant: "holder-black", quantity: 2 }], shippingPaid: "14.00",
  },
  {
    number: "#0985", daysAgo: 38, email: "max.mustermann@example.com",
    shipping: { firstName: "Max", lastName: "Mustermann", address1: "Musterstraße 1", city: "Hamburg", postalCode: "20095", countryCode: "DE", phone: "+49 000 0000001" },
    items: [
      { variant: "fender-x", quantity: 3 }, { variant: "grips-black", quantity: 4 }, { variant: "holder-white", quantity: 2 },
      { variant: "light-std", quantity: 2 }, { variant: "grips-gray", quantity: 1 },
    ],
    shippingPaid: "12.00",
  },
  {
    number: "#0984", daysAgo: 44, email: "john.public@example.com",
    shipping: { firstName: "John Q.", lastName: "Public", address1: "300 Example Blvd", city: "Springfield", province: "IL", postalCode: "62703", countryCode: "US", phone: "+1 202 555 0144" },
    items: [
      { variant: "fender-x", quantity: 2 }, { variant: "grips-black", quantity: 3 }, { variant: "bag-black", quantity: 2 },
      { variant: "holder-black", quantity: 3 }, { variant: "tire-std", quantity: 1 }, { variant: "fender-s", quantity: 1 },
    ],
    shippingPaid: "21.00",
  },
  {
    number: "#0983", daysAgo: 50, email: "joe.blow@example.net",
    shipping: { firstName: "Joe", lastName: "Blow", address1: "2 Sample Street", city: "Melbourne", province: "VIC", postalCode: "3000", countryCode: "AU", phone: "+61 491 570 157" },
    items: [
      { variant: "fender-x", quantity: 2 }, { variant: "grips-black", quantity: 3 }, { variant: "bag-black", quantity: 2 },
      { variant: "holder-white", quantity: 2 }, { variant: "holder-black", quantity: 2 }, { variant: "grips-gray", quantity: 2 },
    ],
    shippingPaid: "22.00",
  },
  {
    number: "#0982", daysAgo: 56, email: "a.n.other@example.org",
    shipping: { firstName: "A. N.", lastName: "Other", address1: "10 Test Street", city: "London", postalCode: "E1 6AN", countryCode: "GB", phone: "+44 7700 900004" },
    items: [
      { variant: "fender-x", quantity: 2 }, { variant: "grips-black", quantity: 2 }, { variant: "bag-black", quantity: 2 }, { variant: "holder-white", quantity: 1 },
      { variant: "holder-black", quantity: 2 }, { variant: "light-std", quantity: 2 }, { variant: "tire-std", quantity: 1 }, { variant: "fender-s", quantity: 1 },
    ],
    shippingPaid: "14.00",
  },
  // 60–89 днів тому (для швидкості за 90 днів).
  {
    number: "#0981", daysAgo: 63, email: "jane.roe@example.com",
    shipping: { firstName: "Jane", lastName: "Roe", address1: "400 Example Ave", city: "Springfield", province: "IL", postalCode: "62704", countryCode: "US", phone: "+1 202 555 0145" },
    items: [{ variant: "fender-x", quantity: 2 }, { variant: "grips-black", quantity: 3 }, { variant: "bag-black", quantity: 2 }, { variant: "holder-black", quantity: 2 }], shippingPaid: "19.00",
  },
  {
    number: "#0980", daysAgo: 70, email: "marie.dupont@example.com",
    shipping: { firstName: "Marie", lastName: "Dupont", address1: "3 Avenue de l'Exemple", city: "Lyon", postalCode: "69002", countryCode: "FR", phone: "+33 0 00 00 00 02" },
    items: [
      { variant: "fender-x", quantity: 2 }, { variant: "grips-black", quantity: 3 }, { variant: "bag-black", quantity: 2 },
      { variant: "holder-white", quantity: 1 }, { variant: "light-std", quantity: 1 },
    ],
    shippingPaid: "12.00",
  },
  {
    number: "#0979", daysAgo: 78, email: "joe.public@example.org",
    shipping: { firstName: "Joe", lastName: "Public", address1: "60 Sample Rd", city: "Ottawa", province: "ON", postalCode: "K1A 0A1", countryCode: "CA", phone: "+1 613 555 0146" },
    items: [
      { variant: "fender-x", quantity: 2 }, { variant: "grips-black", quantity: 2 }, { variant: "bag-black", quantity: 1 },
      { variant: "holder-white", quantity: 1 }, { variant: "holder-black", quantity: 2 }, { variant: "grips-gray", quantity: 2 },
    ],
    shippingPaid: "21.00",
  },
  {
    number: "#0978", daysAgo: 85, email: "tommy.atkins@example.org",
    shipping: { firstName: "Tommy", lastName: "Atkins", address1: "7 Example Road", city: "Manchester", postalCode: "M1 1AA", countryCode: "GB", phone: "+44 7700 900005" },
    items: [
      { variant: "fender-x", quantity: 2 }, { variant: "grips-black", quantity: 2 }, { variant: "bag-black", quantity: 1 },
      { variant: "holder-white", quantity: 1 }, { variant: "holder-black", quantity: 2 }, { variant: "light-std", quantity: 1 },
    ],
    shippingPaid: "14.00",
  },
];

/** Шаблони для кнопки «Імітувати нове оплачене замовлення» (по колу, детерміновано). */
export const SIMULATED_ORDER_TEMPLATES: Omit<DemoOrderSeed, "number" | "hoursAgo">[] = [
  {
    scenario: "simulated: clean",
    email: "anna.k@example.com", contactPhone: null,
    shipping: { firstName: "Anna", lastName: "Kovalenko", address1: "Beispielallee 21", city: "Hamburg", postalCode: "20095", countryCode: "DE", phone: "+49 151 23456780" },
    items: [{ variant: "grips-black", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    scenario: "simulated: missing postal code",
    email: "sofia.m@example.org", contactPhone: null,
    shipping: { firstName: "Sofia", lastName: "Moretti", address1: "Via Prova 15", city: "Roma", postalCode: null, countryCode: "IT", phone: "+39 312 345 6789" },
    items: [{ variant: "holder-white", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    scenario: "simulated: autofix phone format",
    email: "jan.d@example.com", contactPhone: null,
    shipping: { firstName: "Jan", lastName: "Dvořák", address1: "Ukázková 10", city: "Praha", postalCode: "11000", countryCode: "CZ", phone: "00420 601 123 456" },
    items: [{ variant: "fender-s", quantity: 1 }], shippingPaid: "12.00",
  },
];

export const DEMO_SHIPPER = {
  companyName: "ONE TUNNE (демо)",
  contactName: "Demo Manager",
  phone: "+380 67 000 0000",
  email: "logistics@example.com",
  countryCode: "UA",
  city: "Київ",
  postalCode: "01001",
  address1: "вул. Демонстраційна, 1",
  address2: "",
  warehouseName: "Склад Київ (демо)",
  carrierBranch: "Тестове відділення №1",
};
