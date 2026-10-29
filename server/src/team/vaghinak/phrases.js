// Vaghinak's voice (owner, 2026-10-25: "a mix of A and B"): A = a plain colleague who says what he sees and asks one clear thing,
// B = short and direct, a few words, no padding. No jokes, no emoji, no teasing. Every idea has SEVERAL wordings and he never repeats
// the one he used last (pickVariant keeps the recently used ones out). Management gets the formal "Դուք" tone.
// No gender is guessed from a name: he addresses people by "<first name> ջան" / the first name / "Հարազատս", or by
// whatever management typed into the person's "how Vaghinak addresses me" field (users.vaghinak_address).
//
// This file is the "phrase engine" seam: V2 can ask an AI to phrase the same facts and fall back to this bank.
//
// Owner's wording rules (2026-10-27, chose A1 B1 C1 D1; vaghinakWording.test.js enforces them on every line):
//  A1. "խնդրում եմ" only in level-2 lines (the second, insisting message); a level-1 line states the fact and stops.
//  B1. A low result is fact first, one short next step, no mood words ("վատ չէր", "հեշտ չէր", "քիչ է" are out).
//  C1. At most two sentences per message; a list ({names}, {items}, {stats}, {list}) goes below, not in the sentences.
//  D1. The Monday opener stays "Բարի շաբաթ, {addr}։".

const word = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean);
const firstNameOf = (u) => word(u.name_hy || u.name)[0] ?? "";
const lastNameOf = (u) => {
  const w = word(u.name_hy || u.name);
  return w.length > 1 ? w[w.length - 1] : w[0] ?? "";
};

export function addressFor(user, audience, pick = Math.random) {
  if (user.vaghinak_address?.trim()) return user.vaghinak_address.trim();
  const first = firstNameOf(user);
  if (audience === "management") return `Հարգելի ${lastNameOf(user) || first}`;
  const forms = [first, first, `${first} ջան`];
  return forms[Math.floor(pick() * forms.length)];
}

export function durationHy(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} րոպե`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest >= 10 ? `${h} ժամ ${rest} րոպե` : `${h} ժամ`;
}

export const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// kind -> level -> audience -> [templates]. Placeholders: {addr} {late} {time} {dur} {n} {idle} {done} {planned} {pct} ...
const BANK = {
  late_start: {
    1: {
      rep: [
        "{addr}, այսօր սկսեցիր {late} ուշ։ Վաղը փորձիր ժամանակին։",
        "{addr}, այսօր {late} ուշացումով սկսեցիր։ Ինչ-որ բան խանգարե՞ց։",
        "{addr}, {late} ուշացում։ Վաղը՝ ժամանակին։",
        "{addr}, այսօր օրը սկսվեց {late} ուշ։ Եթե պատճառ կար՝ գրիր ինձ։",
        "{addr}, ուշացում՝ {late}։ Վաղը առավոտյան ժամանակին դուրս եկ։",
        "{addr}, այսօր {late} ուշ սկսեցիր։ Վաղը շուտ սկսիր, որ հաճախորդներին հասցնես։",
        "{addr}, նկատեցի, որ այսօր {late} ուշ սկսեցիր։ Վաղը նույնը չկրկնենք։",
      ],
    },
  },
  not_started: {
    1: {
      rep: [
        "{addr}, արդեն {time} է, իսկ այց դեռ չեմ տեսնում։ Ամեն ինչ կարգի՞ն է։",
        "{time}՝ այցեր դեռ չկան։ {addr}, ի՞նչ է կատարվում։",
        "{addr}, {time} է, դեռ ոչ մի այց չկա։ Գրիր՝ ինչպես ես։",
        "{addr}, օրը սկսվել է, բայց քեզ դեռ չեմ տեսնում դաշտում։ Ամեն ինչ լա՞վ է։",
        "{addr}, {time} է, դեռ այց չկա։ Կարո՞ղ եմ ինչով օգնել։",
        "{addr}, դեռ ոչ մի այց չեմ տեսնում։ Ասա՝ ամեն ինչ կարգի՞ն է։",
      ],
    },
    2: {
      rep: [
        "{addr}, արդեն {time} է, այցեր դեռ չկան։ Խնդրում եմ պատասխանիր՝ ի՞նչ է կատարվում։",
        "{addr}, օրվա կեսը մոտենում է, իսկ այցեր չկան։ Ինձ պետք է իմանալ պատճառը։",
        "{time}՝ այց չկա։ {addr}, խնդրում եմ պատասխանիր հիմա։",
        "{addr}, ինձ պետք է իմանալ՝ ինչու դեռ չես սկսել։ Մի րոպե հատկացրու ու պատասխանիր։",
        "{addr}, արդեն {time} է, այցեր չկան։ Մի բառ գրիր, խնդրում եմ։",
      ],
    },
  },
  office_long: {
    1: {
      rep: [
        "{addr}, արդեն {dur} գրասենյակում ես, իսկ պլանում {n} այց կա։ Ժամանակն է դաշտ դուրս գալու։",
        "{addr}, {dur} գրասենյակում ես։ Պլանում դեռ {n} հաճախորդ կա։",
        "Գրասենյակում՝ {dur}, պլանում՝ {n} այց։ {addr}, դուրս գանք դաշտ։",
        "{addr}, {n} հաճախորդ սպասում է քեզ։ Գրասենյակում արդեն {dur} ես։",
        "{addr}, գրասենյակում {dur} ես, պլանում {n} այց կա։ Թղթերը կարելի է թողնել երեկոյին։",
        "{addr}, {dur} է գրասենյակում ես։ Գոնե մեկ այցով սկսիր, մնացածը կհասցնես։",
        "{addr}, գրասենյակում {dur} ես, {n} այց մնացել է։ Կարո՞ղ ես հիմա դուրս գալ։",
        "{addr}, {n} այց կա պլանում, իսկ դու գրասենյակում ես ({dur})։ Ժամանակը գնում է։",
      ],
    },
    2: {
      rep: [
        "{addr}, արդեն {dur} գրասենյակում ես, իսկ {n} այց դեռ մնացել է։ Ասա՝ ինչն է պահում, ես կօգնեմ։",
        "{addr}, ինձ պետք է իմանալ՝ ինչու ես դեռ գրասենյակում ({dur}), պլանում {n} այց կա։ Պատասխանիր, խնդրում եմ։",
        "Գրասենյակում՝ {dur}, պլանում՝ {n} այց։ {addr}, ի՞նչ է կատարվում։",
      ],
    },
  },
  stopped_early: {
    1: {
      rep: [
        "{addr}, վերջին այցից {idle} է անցել, իսկ պլանում դեռ {n} հաճախորդ կա։ Շարունակենք։",
        "{addr}, {idle} է այց չկա, մնացել է {n}։ Հաջորդ հաճախորդը որտե՞ղ է։",
        "Վերջին այցից՝ {idle}, մնացել է՝ {n}։ {addr}, շարունակո՞ւմ ես։",
        "{addr}, լավ սկսեցիր, բայց արդեն {idle} դադար է։ Պլանում {n} այց կա։",
        "{addr}, դադարը {idle} է։ Եթե ճաշում ես՝ լավ, բայց {n} հաճախորդ դեռ սպասում է։",
        "{addr}, վերջին այցը {idle} առաջ էր։ {n} այց մնաց՝ ո՞րից շարունակենք։",
        "{addr}, {n} այց մնացել է պլանից, իսկ վերջին այցից {idle} է անցել։ Ամեն ինչ կարգի՞ն է։",
        "{addr}, {idle} դադար է։ Դեռ ժամանակ կա՝ {n} այց կարելի է հասցնել։",
      ],
    },
    2: {
      rep: [
        "{addr}, {idle} է այց չկա, իսկ {n} հաճախորդ դեռ պլանում է։ Ասա՝ ինչ է պատահել։",
        "{addr}, ինձ պետք է իմանալ՝ ինչու կանգ առար։ Պլանում դեռ {n} այց կա։",
        "{idle} առանց այցի, {n} հաճախորդ պլանում։ {addr}, պատասխանիր, խնդրում եմ։",
      ],
    },
  },
  day_wrap_high: {
    1: {
      rep: [
        "{addr}, այսօր {done}/{planned} այց։ Լավ օր էր, շնորհակալություն։",
        "{addr}, պլանի {pct}%-ը կատարված է։ Լավ աշխատանք, վաղը նույն ձևով։",
        "Այսօր՝ {done}/{planned} այց, {pct}%։ Լավ արդյունք է, {addr}։",
        "{addr}, {done} այց, պլանի {pct}%։ Լավ օր էր։",
        "{addr}, օրը լավ անցավ՝ {done}/{planned}։ Վաղը շարունակենք նույն տեմպով։",
        "{addr}, այսօր պլանի {pct}%-ը արեցիր։ Ապրես, հանգստացիր։",
      ],
    },
  },
  day_wrap_mid: {
    1: {
      rep: [
        "{addr}, այսօր {done} այց՝ պլանի {pct}%։ Վաղը փորձենք հասցնել մնացածը։",
        "{done}/{planned} այց այսօր։ {addr}, վաղը փակենք մնացածը։",
        "{addr}, այսօր {done}/{planned} այց։ Մնացածը՝ վաղը։",
        "{addr}, {done} այց ({pct}%)։ Վաղը՝ մնացածը։",
      ],
    },
  },
  day_wrap_low: {
    1: {
      rep: [
        "{addr}, այսօր պլանի {pct}%-ը ({done}/{planned})։ Վաղը՝ առավոտից դաշտ։",
        "{addr}, այսօր {done}/{planned} այց։ Եթե ինչ-որ բան խանգարեց՝ գրիր։",
        "Այսօր՝ պլանի {pct}% ({done}/{planned})։ {addr}, վաղը՝ մնացածը։",
        "{addr}, {done}/{planned} այց։ Վաղը՝ մնացածը, առավոտից։",
      ],
    },
  },
  day_wrap_free: {
    1: {
      rep: [
        "{addr}, այսօր {done} այց արեցիր։ Վաղվա պլանը պատրաստ պահիր։",
        "{addr}, այսօր՝ {done} այց։ Վաղը էլի դաշտում ենք։",
        "{addr}, {done} այց այսօր։ Լավ օր էր։",
      ],
    },
  },
  data_chase: {
    1: {
      rep: [
        "{addr}, {n} հաճախորդի տվյալներ պակասում են։ Հաջորդ այցին լրացրու։\n{names}",
        "{addr}, այս հաճախորդների հեռախոսը կամ տարածաշրջանը դեռ դատարկ է։ Երբ մոտները լինես՝ լրացրու։\n{names}",
        "{n} հաճախորդի հեռախոսը կամ տարածաշրջանը չկա։ {addr}, հաջորդ այցին լրացրու։\n{names}",
        "{addr}, {n} հաճախորդի տվյալները լրացրու հաջորդ այցին։\n{names}",
        "{addr}, լրացրու այս հաճախորդների հեռախոսը կամ տարածաշրջանը։\n{names}",
        "{addr}, {n} հաճախորդի քարտում տվյալներ չկան։ Հաջորդ այցին լրացրու։\n{names}",
      ],
    },
  },
  data_chase_owner: {
    1: {
      management: [
        "{addr}, {n} հաճախորդ առանց պատասխանատուի կամ առանց վաճառքի ալիքի է, ուստի նրանց ոչ ոք չի այցելում։ Առաջադրանքը Tasks-ում է։",
        "{addr}, նկատեցի {n} հաճախորդ, որոնց վրա պատասխանատու կամ ալիք նշանակված չէ։ Առաջադրանքը Tasks-ում է։",
        "{addr}, {n} հաճախորդ առանց պատասխանատուի կամ ալիքի է։ Առաջադրանքը Tasks-ում է։",
      ],
    },
  },
  downpayment_due: {
    1: {
      rep: [
        "{addr}, կանխավճարը դեռ չի ստացվել, իսկ ապրանքը ճանապարհին է կամ արդեն հանձնվել է։ Հիշեցրու հաճախորդին։\n{items}",
        "{addr}, կանխավճարի հարցը բաց է։ Զանգիր կամ այցելիր հաճախորդին։\n{items}",
        "{addr}, հիշեցում․ այս հաճախորդները դեռ չեն փոխանցել կանխավճարը։ Կարգավորենք այսօր։\n{items}",
        "Կանխավճար դեռ չկա։ {addr}, քաղաքավարի հիշեցրու հաճախորդին։\n{items}",
        "{addr}, այս պատվերների կանխավճարը դեռ չի եկել։ Մեկ զանգով հարցը կլուծվի։\n{items}",
      ],
    },
  },
  downpayment_overdue: {
    1: {
      management: [
        "{addr}, կան առաքված պատվերներ, որոնց կանխավճարը չի ստացվել։ Արժե հետևել։\n{stats}",
        "{addr}, ուշադրություն․ առաքված պատվերների կանխավճար չկա։\n{stats}",
        "{addr}, մի քանի առաքված պատվերի կանխավճար դեռ չի ստացվել։ Արժե հիշեցնել հաճախորդներին։\n{stats}",
      ],
    },
  },
  order_waiting_confirm: {
    1: {
      management: [
        "{addr}, պատվերներ են սպասում հաստատման։\n{stats}",
        "{addr}, հաստատման հերթում պատվերներ կան։ Արժե նայել։\n{stats}",
        "{addr}, հաճախորդները սպասում են․ պատվերները հաստատման են սպասում։\n{stats}",
        "{addr}, մի քանի պատվեր սպասում է Ձեր հաստատմանը։ Հաճախորդները պատասխան են սպասում։\n{stats}",
      ],
    },
  },
  order_waiting_pack: {
    1: {
      management: [
        "{addr}, հաստատված պատվերները դեռ փաթեթավորման չեն անցել։\n{stats}",
        "{addr}, պահեստում պատվերներ են սպասում փաթեթավորման։ Արժե նայել։\n{stats}",
        "{addr}, փաթեթավորման հերթում պատվերներ կան։\n{stats}",
        "{addr}, պահեստում պատվերներ կան, որ դեռ փաթեթավորման չեն անցել։ Ուշադրություն։\n{stats}",
      ],
    },
  },
  order_waiting_escalation: {
    1: {
      management: [
        "{addr}, պատվերներ արդեն սահմանից երկու անգամ ավելի են սպասում։ Պետք է միջամտել։\n{stats}",
        "{addr}, ուշադրություն․ պատվերներ շատ երկար են մնում քայլի վրա։ Պետք է միջամտություն։\n{stats}",
        "{addr}, որոշ պատվերներ արդեն շատ երկար են սպասում․ ժամանակն է միջամտել։\n{stats}",
      ],
    },
  },
  cluster_skip: {
    1: {
      rep: [
        "{addr}, մոտակայքում պլանիցդ չայցելված հաճախորդներ կան։ Մինչև հեռանալդ կարող ես մտնել։\n{names}",
        "{addr}, տարածքից հեռացար, իսկ այս հաճախորդներին դեռ չես այցելել։ Հնարավո՞ր է վերադառնալ։\n{names}",
        "{addr}, կողքի հաճախորդներից մնացել են։ Երկու քայլ է՝ հիմա ամենահեշտ պահն է։\n{names}",
        "{addr}, անցած թաղամասում այս հաճախորդներին դեռ չես հասցրել։ Արժե նայել քարտեզին։\n{names}",
        "{addr}, պլանիցդ կողքի հաճախորդները դեռ սպասում են։ Վերադառնանք։\n{names}",
        "{addr}, մի այց էլ այստեղ, և այս հաճախորդներին էլ կհասցնես՝ շատ մոտ են։\n{names}",
        "{addr}, մոտակայքում չայցելված հաճախորդներ կան։ Քանի այստեղ ես՝ մտիր։\n{names}",
      ],
    },
    2: {
      rep: [
        "{addr}, էլի նույն պատմությունը՝ մոտակայքում մնացել են հաճախորդներ։ Վաղվա երթուղին պլանավորելիս հաշվի առ։\n{names}",
        "{addr}, մեկ այլ տարածքում էլ հաճախորդներ են մնացել չայցելված։ Եթե չես հասցնում, թող վաղվա պլանում լինեն։\n{names}",
        "{addr}, կողքի հաճախորդներ էլի մնացին չայցելված։ Գուցե երթուղին այլ կերպ կազմենք։\n{names}",
      ],
    },
  },
  week_high: {
    1: {
      rep: [
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ պլանի {pct}%-ը կատարեցիր ({done}/{planned} այց)՝ լավ արդյունք է, շարունակենք։{lateNote}",
        "{addr}, անցած շաբաթվա ամփոփում․ {done} այց {planned}-ից՝ {pct}%։ Շատ լավ է։{lateNote}",
        "Անցած շաբաթ՝ {pct}% պլանից ({done}/{planned})։ Ուժեղ շաբաթ էր, {addr}։{lateNote}",
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ՝ պլանի {pct}%, այս շաբաթ էլ նույն տեմպով։{lateNote}",
      ],
    },
  },
  week_mid: {
    1: {
      rep: [
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ պլանի {pct}%-ը արեցիր ({done}/{planned} այց)՝ այս շաբաթ փորձենք մի քիչ ավելի։{lateNote}",
        "{addr}, անցած շաբաթվա ամփոփում․ {done} այց {planned}-ից՝ {pct}%։ Արի ավելացնենք մի քանի հաճախորդ։{lateNote}",
        "Անցած շաբաթ՝ {pct}% պլանից։ Այս շաբաթվա նպատակը՝ 80%, {addr}։{lateNote}",
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ՝ պլանի {pct}%․ այս շաբաթ մի քիչ ավելի։{lateNote}",
      ],
    },
  },
  week_low: {
    1: {
      rep: [
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ՝ պլանի {pct}% ({done}/{planned} այց)․ եթե ինչ-որ բան խանգարում է՝ ասա։{lateNote}",
        "{addr}, անցած շաբաթ՝ {done} այց {planned}-ից ({pct}%)։ Եթե օգնություն է պետք՝ գրիր։{lateNote}",
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ՝ պլանի {pct}%․ այս շաբաթ՝ առավոտից դաշտ։{lateNote}",
        "Անցած շաբաթ՝ {pct}% պլանից։ {addr}, ինչն է խանգարում՝ ասա, կլուծենք։{lateNote}",
      ],
    },
  },
  week_free: {
    1: {
      rep: [
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ {days} օր դաշտում էիր՝ այս շաբաթ էլ նույն տեմպով։{lateNote}",
        "Բարի շաբաթ, {addr}։ Անցած շաբաթ {days} օր դաշտում էիր, շարունակենք։{lateNote}",
      ],
    },
  },
  week_mgmt_quiet: {
    1: {
      management: [
        "{addr}, անցած շաբաթվա ամփոփում․ լուրջ խնդիրներ չեմ նկատել։\n{stats}",
        "{addr}, շաբաթը անցավ հանգիստ․ ուշադրության արժանի շեղումներ չկան։\n{stats}",
        "{addr}, շաբաթը հանգիստ անցավ․ լուրջ շեղումներ չկան։\n{stats}",
      ],
    },
  },
  week_mgmt_issues: {
    1: {
      management: [
        "{addr}, անցած շաբաթվա ամփոփում․ զրույցի կարիք ունեն՝\n{list}\n\n{stats}",
        "{addr}, շաբաթվա արդյունք․ առաջարկում եմ այս շաբաթ առանձին խոսել հետևյալների հետ՝\n{list}\n\n{stats}",
        "{addr}, երկուշաբթվա ամփոփում․ {k} հարց արժե քննարկել՝\n{list}\n\n{stats}",
        "{addr}, անցած շաբաթվա մասին․ առաջարկում եմ առանձին զրուցել հետևյալների հետ՝\n{list}\n\n{stats}",
      ],
    },
  },
  // fullDigest.js: the whole day, every person, for the CEO and the admin only
  full_digest: {
    1: {
      management: [
        "{addr}, օրվա ամբողջական ամփոփումը ({date})․\n\n{body}",
        "{addr}, ահա այսօրվա ամբողջական պատկերը ({date})․\n\n{body}",
        "{addr}, օրվա արդյունքները՝ ըստ յուրաքանչյուր աշխատակցի ({date})․\n\n{body}",
      ],
    },
  },
  mgmt_brief_quiet: {
    1: {
      management: [
        "{addr}, այսօր վաճառքի մենեջերների մասով էական խնդիրներ չեմ նկատել։\n{stats}",
        "{addr}, օրն անցավ հանգիստ․ վաճառքի թիմում լուրջ շեղումներ չկան։\n{stats}",
        "{addr}, այսօր թիմը աշխատել է կայուն։\n{stats}",
        "{addr}, օրը հանգիստ անցավ․ թիմում ուշադրության արժանի ոչինչ չկա։\n{stats}",
      ],
    },
  },
  mgmt_brief_issues: {
    1: {
      management: [
        "{addr}, այսօր ուշադրության արժանի {k} հարց կա՝\n{list}\n\n{stats}",
        "{addr}, վաճառքի թիմում նկատեցի՝\n{list}\n\n{stats}",
        "{addr}, օրվա ամփոփում․\n{list}\n\n{stats}",
        "{addr}, օրվա ընթացքում մի քանի բան նկատեցի, որ արժե ուշադրության՝\n{list}\n\n{stats}",
      ],
    },
  },
};

export const QUESTION_CHOICES = {
  not_started: [
    { key: "day_off", label: "Ազատ օր է" },
    { key: "sick", label: "Հիվանդ եմ" },
    { key: "on_way", label: "Հիմա կսկսեմ" },
    { key: "other", label: "Այլ" },
  ],
  office_long: [
    { key: "meeting", label: "Ժողով / հանդիպում" },
    { key: "paperwork", label: "Փաստաթղթեր / հաշվետվություն" },
    { key: "waiting", label: "Սպասում եմ պատվերի կամ ապրանքի" },
    { key: "car", label: "Մեքենայի խնդիր" },
    { key: "other", label: "Այլ" },
  ],
  stopped_early: [
    { key: "lunch", label: "Ճաշի ընդմիջում" },
    { key: "customer", label: "Հաճախորդի մոտ եմ / սպասում եմ" },
    { key: "car", label: "Մեքենայի խնդիր" },
    { key: "done", label: "Ավարտեցի օրը" },
    { key: "other", label: "Այլ" },
  ],
};

// Picks a template for (kind, level, audience), skipping the variants in `recent` (ids like "office_long:1:rep:3")
// unless that leaves nothing. Returns { text, variant }.
export function pickVariant(kind, level, audience, ctx, recent = [], pick = Math.random) {
  const list = BANK[kind]?.[level]?.[audience];
  if (!list?.length) throw new Error(`No wording for ${kind}/${level}/${audience}`);
  const ids = list.map((_, i) => `${kind}:${level}:${audience}:${i}`);
  const fresh = ids.filter((id) => !recent.includes(id));
  const pool = fresh.length ? fresh : ids;
  const variant = pool[Math.floor(pick() * pool.length)];
  const template = list[ids.indexOf(variant)];
  const text = template.replace(/\{(\w+)\}/g, (_, key) => String(ctx[key] ?? ""));
  return { text, variant };
}

export function variantCount(kind, level, audience) {
  return BANK[kind]?.[level]?.[audience]?.length ?? 0;
}
