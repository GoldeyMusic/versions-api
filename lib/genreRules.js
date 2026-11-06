// lib/genreRules.js — Charte de reconnaissance du craft par esthetique (D.1).
//
// Constat (2026-05-21) : declarer un genre ne changeait quasiment rien a la
// fiche. Claude appliquait sa grille "pop moderne" a tout : une basse chaude
// de ballade retro devenait "envahissante", un kick rond "manquait de punch",
// un lo-fi "manquait d air". Le wording "adapte tes recettes" etait trop mou.
//
// Ici : des REGLES EXPLICITES par famille — ce qui est une signature du genre
// est du CRAFT, pas un defaut ; ce qu il ne faut PAS reprocher ; les cibles
// loudness/dynamique attendues. Le bloc est injecte dans le system prompt de
// la fiche (cf. lib/claude.js, genreBlock) :
//   - genre declare : familles reconnues par mots-cles (sinon charte entiere)
//   - genre a inferer : charte entiere, Claude applique la famille qu il infere
//
// Texte sans accents, comme le reste des prompts.

const FAMILIES = [
  {
    key: 'retro_soul',
    label: 'POP BALLADE RETRO / SOUL / MOTOWN / R&B VINTAGE / FUNK-DISCO 70s',
    match: /\b(retro|r[ée]tro|vintage|motown|soul|funk|disco|70s|60s|doo.?wop|northern|gospel)/i,
    craft: 'basse chaude et ronde avec du bas-medium (100-250 Hz) bien presente ; kick rond sans click ; caisse claire retenue, feutree ; voix proche, compression douce audible ; reverb plate ou chambre perceptible ; stereo moderee ; loudness modere (-13 a -9 LUFS).',
    never: '"basse envahissante", "kick manque de punch", "snare manque d attaque", "manque de brillance moderne", "remonter le loudness".',
  },
  {
    key: 'lofi_boombap',
    label: 'HIP-HOP BOOM-BAP / LO-FI HIP-HOP / LO-FI SOUL',
    match: /\b(boom.?bap|lo.?fi|lofi|chill.?hop|jazz.?hop|90s hip|old.?school|golden era)/i,
    craft: 'samples poussiereux, hiss et crackle, bande passante reduite (coupure vers 10-12 kHz), kick et snare satures ou bitcrushes, swing, voix peu traitee ; dynamique ecrasee acceptable ; loudness -12 a -8 LUFS.',
    never: '"manque d air au-dessus de 10 kHz", "nettoyer le bruit de fond", "la batterie manque de definition", "de-esser plus fort".',
  },
  {
    key: 'trap',
    label: 'TRAP / DRILL / HIP-HOP MODERNE / RAP',
    match: /\b(trap|drill|rap|hip.?hop|cloud|plugg|phonk|grime)/i,
    craft: '808 sub dominant (30-60 Hz) et long, kick fondu dans le 808 ; hats tres presents et rapides ; voix auto-tune, doublages, ad-libs, de-essing marque ; loudness fort (-9 a -6 LUFS) ; peu de reverb longue.',
    never: '"sub excessif" (sauf si la mono-compat ou la phase le cassent reellement), "kick et 808 se confondent" (c est voulu, l item ne vaut que si le 808 masque la VOIX), "trop de hats", "voix trop traitee".',
  },
  {
    key: 'club',
    label: 'TECHNO / HOUSE / TECH-HOUSE / MINIMAL / DUB-TECHNO / TRANCE / DnB',
    match: /\b(techno|house|tech.?house|minimal|trance|club|rave|drum.?(and|n|&).?bass|dnb|jungle|breakbeat|garage|uk ?garage|dubstep|bass music)/i,
    craft: 'kick 4/4 dominant et sub puissant, kick et basse en mono, repetition et longues montees, LRA faible (dynamique ecrasee) normal, saturation analogique ou bande toleree, pads et delays larges ; loudness -9 a -6 LUFS.',
    never: '"trop repetitif", "dynamique ecrasee", "kick trop present", "manque de variete", "ajouter de la reverb sur le kick".',
  },
  {
    key: 'ambient',
    label: 'ELECTRONICA / AMBIENT / DOWNTEMPO / TRIP-HOP / CINEMATIQUE',
    match: /\b(ambient|ambiant|downtempo|trip.?hop|electronica|cinemati|idm|chill|drone|soundscape|new age|post.?rock)/i,
    craft: 'dynamique large, silences et respirations, nappes et reverbs longues, absence possible de kick ou de basse, loudness bas (-18 a -12 LUFS), evolution lente.',
    never: '"manque de punch", "remonter au loudness streaming", "ajouter une batterie", "reverb trop longue", "le morceau n evolue pas".',
  },
  {
    key: 'indie_rock',
    label: 'INDIE ROCK / GARAGE / PUNK / SHOEGAZE / POST-PUNK',
    match: /\b(indie rock|garage rock|punk|shoegaze|post.?punk|noise|grunge|alt.?rock|alternative|rock ind)/i,
    craft: 'guitares saturees qui masquent partiellement la voix, voix en retrait ou noyee de reverb, saturation de bus, batterie de piece, dynamique moyenne, loudness -12 a -8 LUFS.',
    never: '"voix enfouie" comme defaut (c est souvent un choix : au mieux une SUGGESTION), "guitares trop saturees", "trop de reverb", "nettoyer le bas-medium des guitares".',
  },
  {
    key: 'metal',
    label: 'METAL MODERNE / METALCORE / HARDCORE / DJENT',
    match: /\b(metal|m[ée]tal|metalcore|hardcore|djent|deathcore|thrash|doom|sludge)/i,
    craft: 'guitares scoopees (creux 400-800 Hz) et tres larges, kick sample cliquant (3-5 kHz) tres present, caisse claire claquante, compression forte, loudness tres fort (-7 a -5 LUFS), voix saturee ou criee.',
    never: '"kick trop cliquant", "trop compresse", "trop fort", "guitares trop scoopees", "voix agressive".',
  },
  {
    key: 'folk',
    label: 'FOLK / SINGER-SONGWRITER / ACOUSTIQUE / CHANSON',
    match: /\b(folk|singer|songwriter|acousti|chanson|unplugged|intimiste|ballade acoustique|bluegrass)/i,
    craft: 'dynamique preservee, peu de compression, guitare acoustique et voix nue tres devant, bruits de salle, respirations, doigts sur les cordes, stereo naturelle, loudness bas (-16 a -12 LUFS).',
    never: '"remonter le loudness", "densifier le mix", "ajouter du sub", "compresser la voix", "supprimer les bruits de respiration".',
  },
  {
    key: 'jazz_classical',
    label: 'JAZZ / CLASSIQUE / ACOUSTIQUE LIVE / BIG BAND',
    match: /\b(jazz|classi|orchestr|symphon|big band|bebop|swing|chamber|baroque|live acousti|quartet|trio)/i,
    craft: 'scene stereo realiste (placement des instruments), dynamique tres large (LRA > 10 LU), loudness bas (-20 a -14 LUFS), traitement minimal, reverb de salle, bruits de scene.',
    never: '"compresser", "limiter", "remonter au loudness streaming", "elargir artificiellement", "le mix manque d energie".',
  },
  {
    key: 'country',
    label: 'COUNTRY / AMERICANA / POP-COUNTRY',
    match: /\b(country|americana|bluegrass|western|nashville)/i,
    craft: 'voix tres devant et claire, guitares et pedal steel brillantes, basse ronde discrete, batterie naturelle peu compressee, loudness modere (-12 a -9 LUFS).',
    never: '"voix trop en avant", "basse manque de presence", "batterie manque de punch", "trop brillant".',
  },
  {
    key: 'latin',
    label: 'REGGAETON / LATIN / AFROBEATS / DANCEHALL / AMAPIANO',
    match: /\b(reggaeton|latin|latino|afro|afrobeat|dancehall|amapiano|cumbia|bachata|salsa|moombahton)/i,
    craft: 'kick et basse dembow tres en avant, sub present, voix doublees et compressees, percussions brillantes et larges, loudness fort (-9 a -6 LUFS), delays rythmiques.',
    never: '"basse dominante", "voix trop compressee", "percussions trop brillantes", "trop fort".',
  },
  {
    key: 'maximal_pop',
    label: 'K-POP / POP MODERNE / EDM-POP / DANCE-POP',
    match: /\b(k.?pop|j.?pop|edm|dance.?pop|pop moderne|electro.?pop|synth.?pop|hyperpop|mainstream pop|pop commerciale|vari[ée]t[ée])/i,
    craft: 'production maximaliste, empilements vocaux massifs, brillance 8-12 kHz forte, loudness fort (-8 a -6 LUFS), sidechain audible, transitions et drops, voix tres editee.',
    never: '"trop brillant", "trop fort", "trop de couches vocales", "sidechain trop audible", "voix trop editee".',
  },
  {
    key: 'reggae_dub',
    label: 'REGGAE / DUB / SKA',
    match: /\b(reggae|(?<!-)dub\b|ska\b|roots|rocksteady)/i,
    craft: 'basse enorme et ronde qui porte le morceau, kick leger, skank en contretemps, delays et reverb spring tres audibles et mouvants, loudness modere (-13 a -9 LUFS).',
    never: '"basse trop forte", "kick manque de presence", "trop de delay", "reverb trop audible".',
  },
  {
    key: 'rock_blues',
    label: 'ROCK / POP-ROCK / BLUES / CLASSIC ROCK',
    match: /\b(rock(?!.?steady)|pop.?rock|blues|classic rock|hard rock|stoner)/i,
    craft: 'guitares amplifiees avec du grain et de la saturation d ampli, batterie naturelle jouee (pas quantisee), voix brute peu editee, basse ronde qui suit la guitare, dynamique moyenne, loudness -11 a -8 LUFS.',
    never: '"guitares trop saturees", "voix trop brute ou pas assez editee", "batterie manque de precision", "manque de sub", "trop de bas-medium dans les guitares".',
  },
  {
    key: 'neo_soul',
    label: 'R&B MODERNE / NEO-SOUL / ALT-R&B',
    match: /\b(r&b|rnb|r'n'b|neo.?soul|n[ée]o.?soul|alt.?r&b|quiet storm|bedroom)/i,
    craft: 'voix soyeuse et tres traitee (doublages, harmonies, reverb courte), sub discret mais present, batterie laid-back avec swing, accords riches, dynamique moyenne, loudness -12 a -9 LUFS.',
    never: '"voix trop traitee", "batterie manque de punch", "trop de voix en harmonie", "basse manque de definition" si le sub est propre.',
  },
];

// Quand une famille plus specifique est reconnue, la plus generique s efface
// ("lo-fi hip-hop" = lo-fi, pas trap ; "neo-soul" = neo-soul, pas Motown).
const EXCLUDES = {
  lofi_boombap: ['trap'],
  indie_rock: ['rock_blues'],
  reggae_dub: ['rock_blues'],
  neo_soul: ['retro_soul'],
  ambient: ['club'],
  metal: ['indie_rock', 'rock_blues'],
};

function matchFamilies(genre) {
  const s = String(genre || '').toLowerCase();
  if (!s.trim()) return [];
  let matched = FAMILIES.filter((f) => f.match.test(s));
  const drop = new Set(matched.flatMap((f) => EXCLUDES[f.key] || []));
  matched = matched.filter((f) => !drop.has(f.key));
  return matched;
}

function familyText(f) {
  return `- ${f.label} :\n  CRAFT (ne pas penaliser) : ${f.craft}\n  NE JAMAIS reprocher : ${f.never}`;
}

const RULES_HEADER = `
CHARTE PAR ESTHETIQUE — reconnaissance du craft (regle de scoring) :
Les normes de mix ne sont pas universelles. Un geste identique est un defaut dans un genre et une signature dans un autre. Tu DOIS lire chaque element a travers la grille du genre, pas a travers une grille "pop moderne" par defaut.
REGLES :
1. Si un element est ALIGNE sur la signature du genre ET techniquement propre (pas d artefact, pas de masquage destructif, mono-compat correcte), son score est >= 85 et l item eventuel est une SUGGESTION (nature "artistic", priority "low", score >= 72) : il n enleve aucun point.
2. Ne reproche JAMAIS une signature listee en "NE JAMAIS reprocher" pour le genre. Si l ecoute la releve comme un defaut, tu la requalifies en choix esthetique dans le "why".
3. Les cibles loudness/dynamique sont CELLES DU GENRE, pas la cible streaming generique (-14 LUFS) : un master folk a -15 LUFS ou techno a -7 LUFS est dans la norme de son genre.
4. Les vrais defauts restent des defauts quel que soit le genre : clipping intersample, problemes de phase/mono, masquage qui rend la voix inintelligible (quand la voix est censee l etre), sibilantes douloureuses, bruit non voulu, desequilibre L/R accidentel.
5. Si le genre ne correspond a aucune famille ci-dessous, identifie toi-meme les 2-3 signatures sonores typiques de ce genre et applique les memes regles.
`;

/**
 * Bloc de regles a injecter dans le system prompt.
 * @param {string|null} genre — genre declare (ou null si a inferer)
 * @returns {string}
 */
function genreRulesBlock(genre) {
  const matched = matchFamilies(genre);
  const list = matched.length ? matched : FAMILIES;
  const intro = matched.length
    ? `FAMILLE(S) RECONNUE(S) POUR "${String(genre).trim()}" :`
    : (genre
      ? `Aucune famille ne correspond exactement a "${String(genre).trim()}" — charte complete ci-dessous, applique la famille la plus proche (regle 5) :`
      : `Charte complete — applique la famille correspondant au genre que tu inferes de l ecoute :`);
  return `${RULES_HEADER}
${intro}
${list.map(familyText).join('\n')}
`;
}

// Vocabulaire contraint pour l estimation du genre A L ECOUTE (D.2). Chaque
// label se rattache a une famille de la charte via matchFamilies(). Court,
// en francais, sans accent (les prompts sont en ASCII).
const GENRE_VOCAB = [
  'pop ballade retro', 'soul', 'motown', 'r&b vintage', 'funk', 'disco',
  'hip-hop boom-bap', 'lo-fi hip-hop', 'lo-fi soul',
  'trap', 'drill', 'rap', 'hip-hop moderne',
  'techno', 'house', 'tech-house', 'minimal', 'dub-techno', 'trance', 'drum and bass', 'dubstep', 'uk garage',
  'ambient', 'downtempo', 'trip-hop', 'electronica', 'cinematique', 'post-rock',
  'indie rock', 'garage rock', 'punk', 'shoegaze', 'post-punk', 'alt-rock',
  'metal moderne', 'metalcore', 'hardcore',
  'folk', 'singer-songwriter', 'chanson', 'acoustique',
  'jazz', 'classique', 'big band',
  'country', 'americana',
  'reggaeton', 'afrobeats', 'dancehall', 'amapiano', 'latin pop',
  'k-pop', 'pop moderne', 'edm', 'dance-pop', 'synth-pop', 'hyperpop',
  'reggae', 'dub', 'ska',
  'r&b moderne', 'neo-soul', 'alt-r&b',
  'rock', 'pop-rock', 'blues', 'gospel', 'variete',
];

function genreVocabLine() {
  return GENRE_VOCAB.join(' · ');
}

module.exports = { FAMILIES, GENRE_VOCAB, matchFamilies, genreRulesBlock, genreVocabLine };
