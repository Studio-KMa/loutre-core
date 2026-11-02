/**
 * Pools of realistic values, one set per data locale: devs mocking a French API want Marie Dubois in Bordeaux,
 * devs mocking Stripe want Emma Johnson in Austin, and nobody wants John Doe.
 */

export const FIRST_NAMES = [
  "Marie", "Lucas", "Emma", "Hugo", "Léa", "Nathan", "Chloé", "Louis", "Camille", "Jules",
  "Manon", "Gabriel", "Inès", "Arthur", "Sarah", "Adam", "Zoé", "Raphaël", "Lina", "Noah",
  "Anna", "Sofia", "Mohamed", "Fatima", "Yanis", "Aïcha", "Kenji", "Elena", "Diego", "Aya",
  "Malik", "Théo", "Alice", "Paul", "Jeanne", "Samuel", "Nour", "Victor", "Margot", "Ethan",
] as const

export const LAST_NAMES = [
  "Dubois", "Martin", "Bernard", "Petit", "Robert", "Richard", "Durand", "Leroy", "Moreau", "Simon",
  "Laurent", "Lefebvre", "Michel", "Garcia", "David", "Bertrand", "Roux", "Vincent", "Fournier", "Morel",
  "Girard", "André", "Mercier", "Nguyen", "Benali", "Cohen", "Da Silva", "Lopez", "Fontaine", "Rousseau",
  "Blanc", "Guérin", "Muller", "Henry", "Perrin", "Morin", "Mathieu", "Clément", "Gauthier", "Dumont",
] as const

export const EMAIL_DOMAINS = [
  "gmail.com", "gmail.com", "outlook.fr", "proton.me", "orange.fr", "free.fr", "icloud.com", "yahoo.fr", "laposte.net",
] as const

export interface City {
  readonly name: string
  readonly zip: string
  readonly region: string
  readonly lat: number
  readonly lng: number
}

export const CITIES: ReadonlyArray<City> = [
  { name: "Paris", zip: "75011", region: "Île-de-France", lat: 48.8566, lng: 2.3522 },
  { name: "Lyon", zip: "69003", region: "Auvergne-Rhône-Alpes", lat: 45.764, lng: 4.8357 },
  { name: "Marseille", zip: "13006", region: "Provence-Alpes-Côte d'Azur", lat: 43.2965, lng: 5.3698 },
  { name: "Bordeaux", zip: "33000", region: "Nouvelle-Aquitaine", lat: 44.8378, lng: -0.5792 },
  { name: "Toulouse", zip: "31000", region: "Occitanie", lat: 43.6047, lng: 1.4442 },
  { name: "Nantes", zip: "44000", region: "Pays de la Loire", lat: 47.2184, lng: -1.5536 },
  { name: "Lille", zip: "59000", region: "Hauts-de-France", lat: 50.6292, lng: 3.0573 },
  { name: "Strasbourg", zip: "67000", region: "Grand Est", lat: 48.5734, lng: 7.7521 },
  { name: "Rennes", zip: "35000", region: "Bretagne", lat: 48.1173, lng: -1.6778 },
  { name: "Montpellier", zip: "34000", region: "Occitanie", lat: 43.6108, lng: 3.8767 },
  { name: "Nice", zip: "06000", region: "Provence-Alpes-Côte d'Azur", lat: 43.7102, lng: 7.262 },
  { name: "Grenoble", zip: "38000", region: "Auvergne-Rhône-Alpes", lat: 45.1885, lng: 5.7245 },
  { name: "Dijon", zip: "21000", region: "Bourgogne-Franche-Comté", lat: 47.322, lng: 5.0415 },
  { name: "Angers", zip: "49000", region: "Pays de la Loire", lat: 47.4784, lng: -0.5632 },
  { name: "Tours", zip: "37000", region: "Centre-Val de Loire", lat: 47.3941, lng: 0.6848 },
  { name: "Annecy", zip: "74000", region: "Auvergne-Rhône-Alpes", lat: 45.8992, lng: 6.1294 },
  { name: "La Rochelle", zip: "17000", region: "Nouvelle-Aquitaine", lat: 46.1603, lng: -1.1511 },
  { name: "Biarritz", zip: "64200", region: "Nouvelle-Aquitaine", lat: 43.4832, lng: -1.5586 },
  { name: "Brest", zip: "29200", region: "Bretagne", lat: 48.3904, lng: -4.4861 },
  { name: "Reims", zip: "51100", region: "Grand Est", lat: 49.2583, lng: 4.0317 },
]

export const STREETS = [
  "12 rue de la République", "48 avenue Jean Jaurès", "3 place des Lices", "27 boulevard Voltaire",
  "8 rue des Lilas", "15 quai des Chartrons", "61 rue Nationale", "4 impasse du Moulin",
  "22 rue Victor Hugo", "9 allée des Tilleuls", "35 cours Gambetta", "17 rue Sainte-Catherine",
  "2 chemin des Vignes", "40 rue du Faubourg Saint-Antoine", "6 place de la Comédie",
] as const

export const COMPANIES = [
  "Atelier Dubois", "Studio Nord", "Maison Laurent", "Bleu Cobalt", "Loutre & Fils", "Cap Horizon",
  "Dune Studio", "Lumière SAS", "Ferme des Cévennes", "Pixelune", "Mistral Data", "Ondine",
  "Belharra", "Nébuleuse", "Sillage", "Bocage & Co", "Alizé Logistique", "Grain de Sel",
  "Boréale", "Épicerie Roux", "Ravel Industries", "Nomade Tech", "Estuaire", "Kalos",
] as const

export const PRODUCTS = [
  "Chaise Bistrot chêne", "Lampe Nomade", "Carnet Grain fin A5", "Sac week-end toile", "Cafetière piston 1 L",
  "Casque Onde", "Table basse Ardoise", "Plaid laine mérinos", "Bougie Cèdre & Figue", "Gourde inox 750 ml",
  "Vase Nébuleuse", "Tapis Lisboa", "Montre Méridien", "Sneakers Sillage", "Enceinte Alto",
  "Clavier Type 65", "Écouteurs Brume", "Théière fonte", "Coussin lin lavé", "Miroir Lune",
  "Étagère Atlas", "Veste Cap Horn", "Planche à découper noyer", "Kit démarrage céramique",
] as const

export const PETS = [
  "Biscotte", "Mochi", "Nala", "Simba", "Oscar", "Louna", "Réglisse", "Pistache", "Filou", "Caramel",
  "Rocky", "Maya", "Chipie", "Tigrou", "Noisette", "Vanille", "Praline", "Gaston", "Falco", "Plume",
] as const

export const TITLES = [
  "Pourquoi nos mocks mentent (et comment y remédier)", "Migrer vers OpenAPI 3.1 sans douleur",
  "Le guide du café filtre", "Dix idées de week-end en Bretagne", "Comprendre les index Postgres",
  "Notre feuille de route 2026", "Un matin à Bordeaux", "Design system : par où commencer",
  "Tarte aux pommes façon grand-mère", "Les cinq erreurs de l'onboarding", "Réduire la latence perçue",
  "Ce que le front attend du back", "Journal d'une refonte", "Choisir sa base de données en 2026",
] as const

export const SENTENCES = [
  "Livraison offerte dès 50 € d'achat en France métropolitaine.",
  "Fabriqué à la main dans notre atelier de Nantes.",
  "Ce contenu est mis à jour chaque semaine par l'équipe.",
  "Disponible en trois coloris, garanti deux ans.",
  "Un classique revisité, pensé pour durer.",
  "Les données sont synchronisées toutes les quinze minutes.",
  "Idéal pour les petits espaces et les grandes ambitions.",
  "Retour gratuit sous trente jours, sans justification.",
  "Conçu avec des matériaux recyclés à 80 %.",
  "Une sélection soignée, renouvelée chaque saison.",
  "Compatible avec l'ensemble de la gamme existante.",
  "Testé et approuvé par plus de mille clients.",
] as const

export const TAGS = [
  "nouveau", "promo", "populaire", "bio", "made-in-france", "bêta", "urgent", "interne",
  "premium", "édition-limitée", "recyclé", "vintage", "été", "hiver", "bois", "lin",
] as const

export const CATEGORIES = [
  "Maison", "Mode", "Tech", "Épicerie", "Jardin", "Sport", "Beauté", "Enfant", "Bureau", "Loisirs",
] as const

export const STATUSES = ["active", "pending", "archived", "draft"] as const
export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"] as const
export const ROLES = ["admin", "member", "viewer", "owner"] as const
export const PLANS = ["free", "pro", "team", "enterprise"] as const
export const CURRENCIES = ["EUR", "EUR", "EUR", "USD", "GBP", "CHF"] as const
export const COUNTRIES = [
  { name: "France", code: "FR" }, { name: "France", code: "FR" }, { name: "Belgique", code: "BE" },
  { name: "Suisse", code: "CH" }, { name: "Espagne", code: "ES" }, { name: "Allemagne", code: "DE" },
  { name: "Italie", code: "IT" }, { name: "Canada", code: "CA" }, { name: "Portugal", code: "PT" },
] as const
export const COLORS = ["#C6F24E", "#7CF0C4", "#FF8A3D", "#B8A8FF", "#0B0C0E", "#E7E9EC", "#3B82F6", "#EF4444"] as const
export const LOCALES = ["fr-FR", "fr-FR", "fr-BE", "en-GB", "de-DE", "es-ES"] as const
export const TIMEZONES = ["Europe/Paris", "Europe/Paris", "Europe/Brussels", "Europe/Zurich", "America/Montreal"] as const
export const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
] as const
export const WORDS = [
  "Alpha", "Boréale", "Cobalt", "Dune", "Estuaire", "Falaise", "Granit", "Horizon", "Iris", "Jade",
  "Kelp", "Lagune", "Mistral", "Nacre", "Ondine", "Pollen", "Quartz", "Rivage", "Sillage", "Tourbe",
] as const
/**
 * Realistic values for common field names no semantic covers, read on the whole name first
 * (`file_name` → filename), then on its last word (`deploy_environment` → environment). Used only
 * where the field would otherwise read "Environment Dune".
 */
export const NAMED_VALUES: Readonly<Record<string, ReadonlyArray<string>>> = {
  environment: ["production", "staging", "development", "preview"],
  env: ["production", "staging", "development", "preview"],
  branch: ["main", "develop", "feature/paiement-3ds", "fix/arrondi-tva", "release/2.4"],
  os: ["linux", "macos", "windows", "ios", "android"],
  platform: ["web", "ios", "android", "desktop"],
  architecture: ["x86_64", "arm64", "aarch64"],
  arch: ["x86_64", "arm64", "aarch64"],
  channel: ["web", "mobile", "email", "sms", "api"],
  source: ["web", "api", "import", "mobile", "partenaire"],
  origin: ["web", "api", "import", "mobile"],
  medium: ["organic", "cpc", "email", "social", "referral"],
  campaign: ["rentree-2026", "black-friday", "newsletter-octobre", "soldes-hiver", "lancement-pro"],
  segment: ["particuliers", "pme", "grands-comptes", "etudiants", "early-adopters"],
  cohort: ["2026-07", "2026-08", "2026-09", "2026-10"],
  location: ["Lyon", "Nantes", "Bordeaux", "Lille", "Paris 11e", "Marseille"],
  path: ["/var/data/exports/rapport-2026-09.csv", "/home/app/uploads/avatar.png", "/srv/backups/db-2026-10-01.sql.gz", "/etc/app/config.yaml"],
  filepath: ["/var/data/exports/rapport-2026-09.csv", "/home/app/uploads/avatar.png", "/srv/backups/db-2026-10-01.sql.gz"],
  filename: ["rapport-trimestriel.pdf", "facture-2026-09.pdf", "export-clients.csv", "photo-profil.jpg", "contrat-signe.pdf"],
  file: ["rapport-trimestriel.pdf", "facture-2026-09.pdf", "export-clients.csv", "photo-profil.jpg"],
  extension: ["pdf", "csv", "png", "json", "xlsx"],
  mimetype: ["application/pdf", "image/png", "text/csv", "application/json"],
  mime: ["application/pdf", "image/png", "text/csv", "application/json"],
  contenttype: ["application/json", "application/pdf", "image/png", "text/csv"],
  encoding: ["utf-8", "gzip", "base64"],
  provider: ["stripe", "google", "github", "microsoft", "apple"],
  action: ["create", "update", "delete", "login", "export"],
  operation: ["create", "update", "delete", "read"],
  event: ["user.created", "invoice.paid", "order.shipped", "subscription.canceled"],
  eventtype: ["user.created", "invoice.paid", "order.shipped", "subscription.canceled"],
  method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  httpmethod: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  verb: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  resource: ["users", "invoices", "orders", "projects"],
  namespace: ["default", "production", "monitoring", "kube-system"],
  package: ["react", "hono", "effect", "zod", "vite"],
  packagename: ["react", "hono", "effect", "zod", "vite"],
  service: ["api", "web", "worker", "billing", "auth"],
  duration: ["PT15M", "PT1H", "PT30S", "P1D"],
  size: ["S", "M", "L", "XL"],
  alias: ["prod", "latest", "stable", "beta"],
  query: ["status:open", "tag:urgent", "facture 2026", "loutre"],
  nationality: ["FR", "BE", "CH", "DE", "ES"],
  bucket: ["app-uploads", "app-backups", "assets-prod"],
  prefix: ["uploads/2026/10/", "exports/", "backups/"],
  operator: ["eq", "gt", "lt", "contains"],
  mcc: ["5411", "5812", "5999", "4121"],
  market: ["FR", "BE", "CH", "CA", "DE", "ES"],
  codedepartement: ["75", "69", "13", "33", "44", "2A", "59", "35", "31", "67"],
  coderegion: ["11", "84", "93", "75", "52", "53", "76", "44"],
  codecommune: ["75056", "69123", "13055", "33063", "44109", "35238", "31555", "67482"],
  codeinsee: ["75056", "69123", "13055", "33063", "44109", "35238", "31555", "67482"],
  codeepci: ["200054781", "200046977", "200054807", "243300316", "244400404"],
}
/** Calendar parts written as text (`"year": "2024"`, `"mois": "7"`), by the word that names them. */
export const CALENDAR_VALUES: Readonly<Record<string, ReadonlyArray<string>>> = {
  year: ["2021", "2022", "2023", "2024", "2025", "2026"],
  annee: ["2021", "2022", "2023", "2024", "2025", "2026"],
  month: ["1", "3", "5", "7", "9", "11", "12"],
  mois: ["1", "3", "5", "7", "9", "11", "12"],
  day: ["2", "7", "11", "16", "21", "25", "28"],
  jour: ["2", "7", "11", "16", "21", "25", "28"],
}
/** Fields whose value is a hexadecimal fingerprint (`commit`, `sha256`), by length. */
export const FINGERPRINTS: Readonly<Record<string, number>> = { sha: 40, sha1: 40, commit: 40, hash: 40, checksum: 40, digest: 64, sha256: 64, md5: 32 }
export const ADJECTIVES = ["nouveau", "compact", "durable", "classique", "premium", "léger", "modulaire", "essentiel"] as const
/** Why a payment or an operation failed (`failure_message`, `decline_reason`). */
export const PAYMENT_FAILURES = [
  "Votre carte a été refusée.", "Fonds insuffisants.", "La carte a expiré.", "Code de sécurité incorrect.",
  "La banque a refusé l'opération.", "Erreur de traitement, réessayez dans un instant.",
] as const
export const FAILURES = [
  "Délai dépassé après 30 secondes.", "Service amont indisponible.", "Validation échouée : champ obligatoire manquant.",
  "Accès refusé.", "Limite de requêtes atteinte.", "Fichier introuvable.",
] as const

// ─── English ─────────────────────────────────────────────────────────────────

export const FIRST_NAMES_EN = [
  "Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Sophia", "Mason", "Isabella", "Lucas",
  "Mia", "James", "Amelia", "Benjamin", "Harper", "Elijah", "Charlotte", "Daniel", "Grace", "Henry",
  "Chloe", "Jack", "Priya", "Arjun", "Mei", "Wei", "Sofia", "Diego", "Fatima", "Omar",
  "Aisha", "Kenji", "Yuki", "Zara", "Leo", "Nora", "Samuel", "Maya", "Owen", "Ruby",
] as const

export const LAST_NAMES_EN = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
  "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Lee", "Harris", "Clark", "Lewis",
  "Walker", "Hall", "Young", "King", "Wright", "Lopez", "Hill", "Scott", "Green", "Adams",
  "Nguyen", "Patel", "Kim", "Chen", "Singh", "Okafor", "Cohen", "Murphy", "Rossi", "Tanaka",
] as const

export const EMAIL_DOMAINS_EN = [
  "gmail.com", "gmail.com", "outlook.com", "icloud.com", "yahoo.com", "proton.me", "hey.com", "fastmail.com",
] as const

/** `region` is the state's postal code, as US APIs (Stripe, Shopify) write it. */
export const CITIES_EN: ReadonlyArray<City> = [
  { name: "San Francisco", zip: "94103", region: "CA", lat: 37.7749, lng: -122.4194 },
  { name: "New York", zip: "10001", region: "NY", lat: 40.7128, lng: -74.006 },
  { name: "Austin", zip: "78701", region: "TX", lat: 30.2672, lng: -97.7431 },
  { name: "Seattle", zip: "98101", region: "WA", lat: 47.6062, lng: -122.3321 },
  { name: "Chicago", zip: "60601", region: "IL", lat: 41.8781, lng: -87.6298 },
  { name: "Boston", zip: "02108", region: "MA", lat: 42.3601, lng: -71.0589 },
  { name: "Denver", zip: "80202", region: "CO", lat: 39.7392, lng: -104.9903 },
  { name: "Portland", zip: "97204", region: "OR", lat: 45.5152, lng: -122.6784 },
  { name: "Atlanta", zip: "30303", region: "GA", lat: 33.749, lng: -84.388 },
  { name: "Miami", zip: "33130", region: "FL", lat: 25.7617, lng: -80.1918 },
  { name: "Los Angeles", zip: "90012", region: "CA", lat: 34.0522, lng: -118.2437 },
  { name: "Brooklyn", zip: "11201", region: "NY", lat: 40.6782, lng: -73.9442 },
  { name: "Minneapolis", zip: "55401", region: "MN", lat: 44.9778, lng: -93.265 },
  { name: "Nashville", zip: "37203", region: "TN", lat: 36.1627, lng: -86.7816 },
  { name: "Philadelphia", zip: "19103", region: "PA", lat: 39.9526, lng: -75.1652 },
  { name: "San Diego", zip: "92101", region: "CA", lat: 32.7157, lng: -117.1611 },
  { name: "Salt Lake City", zip: "84101", region: "UT", lat: 40.7608, lng: -111.891 },
  { name: "Raleigh", zip: "27601", region: "NC", lat: 35.7796, lng: -78.6382 },
  { name: "Pittsburgh", zip: "15222", region: "PA", lat: 40.4406, lng: -79.9959 },
  { name: "Madison", zip: "53703", region: "WI", lat: 43.0731, lng: -89.4012 },
]

export const STREETS_EN = [
  "1450 Market Street", "221 Pine Street", "48 Elm Street", "905 Congress Avenue", "17 Harbor Drive",
  "3200 Lake Shore Drive", "610 Maple Avenue", "84 Bedford Street", "1201 Oak Lane", "55 Water Street",
  "2400 Sunset Boulevard", "9 Orchard Road", "318 Cedar Street", "700 Broadway", "26 Mill Road",
] as const

export const COMPANIES_EN = [
  "Bluebird Supply", "Harbor & Pine", "Lumen Analytics", "Cedar Street Coffee", "Otter & Sons", "Northline Logistics",
  "Fernwood Studio", "Brightside Health", "Quarry Works", "Juniper Systems", "Maple & Oak", "Copperleaf",
  "Driftwood Media", "Summit Outfitters", "Ironclad Security", "Tidewater Foods", "Lantern Software", "Kestrel Robotics",
  "Bramble & Co", "Granite Peak", "Wildflower Bakery", "Silverline Data", "Pebble Finance", "Riverbend Farms",
] as const

export const PRODUCTS_EN = [
  "Oak bistro chair", "Nomad desk lamp", "A5 dot-grid notebook", "Canvas weekender bag", "French press 34 oz",
  "Wave headphones", "Slate coffee table", "Merino wool throw", "Cedar & Fig candle", "Steel water bottle 24 oz",
  "Nebula vase", "Lisbon rug", "Meridian watch", "Wake sneakers", "Alto speaker",
  "Type 65 keyboard", "Mist earbuds", "Cast iron teapot", "Washed linen cushion", "Moon mirror",
  "Atlas shelf", "Cape Horn jacket", "Walnut cutting board", "Ceramic starter kit",
] as const

export const PETS_EN = [
  "Biscuit", "Mochi", "Nala", "Simba", "Oscar", "Luna", "Pepper", "Pistachio", "Ziggy", "Caramel",
  "Rocky", "Maya", "Bean", "Tiger", "Hazel", "Vanilla", "Waffles", "Gus", "Falco", "Feather",
] as const

export const TITLES_EN = [
  "Why our mocks lie (and how to fix it)", "Migrating to OpenAPI 3.1 without the pain",
  "A field guide to pour-over coffee", "Ten weekend trips along the coast", "Understanding Postgres indexes",
  "Our 2026 roadmap", "A morning in Portland", "Design systems: where to start",
  "Grandma's apple pie", "Five onboarding mistakes", "Reducing perceived latency",
  "What the frontend needs from the backend", "Notes from a redesign", "Choosing a database in 2026",
] as const

export const SENTENCES_EN = [
  "Free shipping on orders over $50.",
  "Handmade in our Portland workshop.",
  "This content is updated weekly by the team.",
  "Available in three colors, with a two-year warranty.",
  "A classic, reworked to last.",
  "Data syncs every fifteen minutes.",
  "Great for small spaces and big ambitions.",
  "Free returns within thirty days, no questions asked.",
  "Made with 80% recycled materials.",
  "A carefully curated selection, refreshed every season.",
  "Compatible with the whole existing range.",
  "Tested and approved by over a thousand customers.",
] as const

export const TAGS_EN = [
  "new", "sale", "popular", "organic", "handmade", "beta", "urgent", "internal",
  "premium", "limited-edition", "recycled", "vintage", "summer", "winter", "wood", "linen",
] as const

export const CATEGORIES_EN = ["Home", "Fashion", "Tech", "Grocery", "Garden", "Sports", "Beauty", "Kids", "Office", "Leisure"] as const
export const CURRENCIES_EN = ["USD", "USD", "USD", "EUR", "GBP", "CAD"] as const
export const COUNTRIES_EN = [
  { name: "United States", code: "US" }, { name: "United States", code: "US" }, { name: "Canada", code: "CA" },
  { name: "United Kingdom", code: "GB" }, { name: "Germany", code: "DE" }, { name: "France", code: "FR" },
  { name: "Australia", code: "AU" }, { name: "Ireland", code: "IE" }, { name: "Netherlands", code: "NL" },
] as const
export const LOCALES_EN = ["en-US", "en-US", "en-GB", "fr-FR", "de-DE", "es-ES"] as const
export const TIMEZONES_EN = ["America/New_York", "America/New_York", "America/Los_Angeles", "America/Chicago", "Europe/London"] as const
export const WORDS_EN = [
  "Alpha", "Aurora", "Cobalt", "Dune", "Estuary", "Falcon", "Granite", "Horizon", "Iris", "Jade",
  "Kelp", "Lagoon", "Mistral", "Nimbus", "Onyx", "Pollen", "Quartz", "Ridge", "Summit", "Tundra",
] as const
/** The French named values whose words are French; codes and technical values are shared. */
export const NAMED_VALUES_EN: Readonly<Record<string, ReadonlyArray<string>>> = {
  ...NAMED_VALUES,
  branch: ["main", "develop", "feature/3ds-payments", "fix/vat-rounding", "release/2.4"],
  source: ["web", "api", "import", "mobile", "partner"],
  campaign: ["back-to-school-2026", "black-friday", "october-newsletter", "winter-sale", "pro-launch"],
  segment: ["consumers", "smb", "enterprise", "students", "early-adopters"],
  location: ["Austin", "Seattle", "Brooklyn", "Denver", "San Francisco", "Chicago"],
  path: ["/var/data/exports/report-2026-09.csv", "/home/app/uploads/avatar.png", "/srv/backups/db-2026-10-01.sql.gz", "/etc/app/config.yaml"],
  filepath: ["/var/data/exports/report-2026-09.csv", "/home/app/uploads/avatar.png", "/srv/backups/db-2026-10-01.sql.gz"],
  filename: ["quarterly-report.pdf", "invoice-2026-09.pdf", "customers-export.csv", "profile-photo.jpg", "signed-contract.pdf"],
  file: ["quarterly-report.pdf", "invoice-2026-09.pdf", "customers-export.csv", "profile-photo.jpg"],
  query: ["status:open", "tag:urgent", "invoice 2026", "otter"],
  nationality: ["US", "GB", "CA", "DE", "FR"],
  market: ["US", "GB", "CA", "DE", "FR", "AU"],
}
export const PAYMENT_FAILURES_EN = [
  "Your card was declined.", "Insufficient funds.", "Your card has expired.", "Your card's security code is incorrect.",
  "The bank declined the transaction.", "A processing error occurred, please try again.",
] as const
export const FAILURES_EN = [
  "Timed out after 30 seconds.", "Upstream service unavailable.", "Validation failed: missing required field.",
  "Permission denied.", "Rate limit exceeded.", "File not found.",
] as const

/** Error code and message per HTTP status, for 4xx/5xx bodies. */
export const ERROR_TEXTS: Record<number, { readonly code: string; readonly message: string }> = {
  400: { code: "bad_request", message: "La requête est invalide : vérifiez les champs envoyés." },
  401: { code: "unauthorized", message: "Authentification requise." },
  402: { code: "payment_required", message: "Paiement requis pour accéder à cette ressource." },
  403: { code: "forbidden", message: "Vous n'avez pas les droits nécessaires." },
  404: { code: "not_found", message: "La ressource demandée est introuvable." },
  405: { code: "method_not_allowed", message: "Méthode non autorisée sur cette ressource." },
  409: { code: "conflict", message: "Conflit : la ressource existe déjà ou a changé entre-temps." },
  410: { code: "gone", message: "Cette ressource n'existe plus." },
  422: { code: "unprocessable_entity", message: "Les données envoyées ne passent pas la validation." },
  429: { code: "too_many_requests", message: "Trop de requêtes : réessayez dans quelques secondes." },
  500: { code: "internal_error", message: "Une erreur interne est survenue, nos loutres sont dessus." },
  502: { code: "bad_gateway", message: "Passerelle invalide." },
  503: { code: "service_unavailable", message: "Service momentanément indisponible." },
  504: { code: "gateway_timeout", message: "Le service amont n'a pas répondu à temps." },
}

export const ERROR_TEXTS_EN: Record<number, { readonly code: string; readonly message: string }> = {
  400: { code: "bad_request", message: "The request is invalid: check the fields you sent." },
  401: { code: "unauthorized", message: "Authentication required." },
  402: { code: "payment_required", message: "Payment is required to access this resource." },
  403: { code: "forbidden", message: "You don't have permission to do that." },
  404: { code: "not_found", message: "The requested resource was not found." },
  405: { code: "method_not_allowed", message: "This method is not allowed on this resource." },
  409: { code: "conflict", message: "Conflict: the resource already exists or changed in the meantime." },
  410: { code: "gone", message: "This resource no longer exists." },
  422: { code: "unprocessable_entity", message: "The data sent did not pass validation." },
  429: { code: "too_many_requests", message: "Too many requests: try again in a few seconds." },
  500: { code: "internal_error", message: "An internal error occurred, our otters are on it." },
  502: { code: "bad_gateway", message: "Bad gateway." },
  503: { code: "service_unavailable", message: "Service temporarily unavailable." },
  504: { code: "gateway_timeout", message: "The upstream service did not respond in time." },
}

/** Language of the generated data, recorded with it: a mock regenerates and answers its errors in its own. */
export type DataLocale = "fr" | "en"

export const errorTextFor = (status: number, locale: DataLocale = "fr"): { readonly code: string; readonly message: string } => {
  const known = (locale === "en" ? ERROR_TEXTS_EN : ERROR_TEXTS)[status]
  if (known !== undefined) return known
  if (locale === "en") return status >= 500 ? { code: "server_error", message: "Server error." } : { code: "request_error", message: "The request could not be processed." }
  return status >= 500 ? { code: "server_error", message: "Erreur côté serveur." } : { code: "request_error", message: "La requête n'a pas pu être traitée." }
}

/** Every value that depends on the data locale. */
export interface Pools {
  readonly locale: DataLocale
  readonly firstNames: ReadonlyArray<string>
  readonly lastNames: ReadonlyArray<string>
  readonly emailDomains: ReadonlyArray<string>
  readonly cities: ReadonlyArray<City>
  readonly streets: ReadonlyArray<string>
  readonly companies: ReadonlyArray<string>
  readonly companyTld: string
  readonly products: ReadonlyArray<string>
  readonly pets: ReadonlyArray<string>
  readonly titles: ReadonlyArray<string>
  readonly sentences: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly categories: ReadonlyArray<string>
  readonly currencies: ReadonlyArray<string>
  readonly countries: ReadonlyArray<{ readonly name: string; readonly code: string }>
  readonly homeCountry: string
  readonly homeCountryCode: string
  readonly locales: ReadonlyArray<string>
  readonly timezones: ReadonlyArray<string>
  readonly words: ReadonlyArray<string>
  readonly named: Readonly<Record<string, ReadonlyArray<string>>>
  readonly paymentFailures: ReadonlyArray<string>
  readonly failures: ReadonlyArray<string>
  /** Fallback label of a field nothing describes. */
  readonly value: string
}

export const POOLS: Readonly<Record<DataLocale, Pools>> = {
  fr: {
    locale: "fr",
    firstNames: FIRST_NAMES,
    lastNames: LAST_NAMES,
    emailDomains: EMAIL_DOMAINS,
    cities: CITIES,
    streets: STREETS,
    companies: COMPANIES,
    companyTld: "fr",
    products: PRODUCTS,
    pets: PETS,
    titles: TITLES,
    sentences: SENTENCES,
    tags: TAGS,
    categories: CATEGORIES,
    currencies: CURRENCIES,
    countries: COUNTRIES,
    homeCountry: "France",
    homeCountryCode: "FR",
    locales: LOCALES,
    timezones: TIMEZONES,
    words: WORDS,
    named: NAMED_VALUES,
    paymentFailures: PAYMENT_FAILURES,
    failures: FAILURES,
    value: "valeur",
  },
  en: {
    locale: "en",
    firstNames: FIRST_NAMES_EN,
    lastNames: LAST_NAMES_EN,
    emailDomains: EMAIL_DOMAINS_EN,
    cities: CITIES_EN,
    streets: STREETS_EN,
    companies: COMPANIES_EN,
    companyTld: "com",
    products: PRODUCTS_EN,
    pets: PETS_EN,
    titles: TITLES_EN,
    sentences: SENTENCES_EN,
    tags: TAGS_EN,
    categories: CATEGORIES_EN,
    currencies: CURRENCIES_EN,
    countries: COUNTRIES_EN,
    homeCountry: "United States",
    homeCountryCode: "US",
    locales: LOCALES_EN,
    timezones: TIMEZONES_EN,
    words: WORDS_EN,
    named: NAMED_VALUES_EN,
    paymentFailures: PAYMENT_FAILURES_EN,
    failures: FAILURES_EN,
    value: "value",
  },
}
