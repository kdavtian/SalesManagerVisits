# User-guide text, both languages, one entry per section. build.py turns this
# into the PDFs shipped in client/public/docs/. Keep the Armenian labels in
# sync with client/public/js/i18n.js (the guide quotes the app's own words).
#
# Section shape: id, title, intro (optional), blocks (list), img (optional
# screenshot name from screens/), cap (optional caption).
# Block kinds: ("p", text) ("ul", [items]) ("ol", [steps]) ("tip", text)
# ("note", text) ("table", [[cell, ...], ...] first row = header).

VERSION = "1.251.0"

UI = {
    "hy": {
        "lang_name": "Հայերեն",
        "cover_title": "Օգտագործման ուղեցույց",
        "cover_sub": "Վաճառքի մենեջերների համար",
        "cover_app": "KAD Motors · Field Visits հավելված",
        "cover_ver": "Հավելվածի տարբերակ {v}",
        "toc": "Բովանդակություն",
        "tip": "Խորհուրդ",
        "note": "Կարևոր է",
        "footer": "KAD Motors · Օգտագործման ուղեցույց · տարբերակ {v}",
        "demo": "Էկրանի նկարները վերցված են ցուցադրական տվյալներով։",
    },
    "en": {
        "lang_name": "English",
        "cover_title": "User guide",
        "cover_sub": "For sales managers",
        "cover_app": "KAD Motors · Field Visits app",
        "cover_ver": "App version {v}",
        "toc": "Contents",
        "tip": "Tip",
        "note": "Important",
        "footer": "KAD Motors · User guide · version {v}",
        "demo": "Screenshots use demonstration data.",
    },
}

SECTIONS = {}

# ---------------------------------------------------------------- Armenian
SECTIONS["hy"] = [
    dict(
        id="start",
        title="1. Սկսելու համար",
        img="home",
        cap="Գլխավոր էկրան",
        blocks=[
            ("p", "KAD Motors-ի Field Visits հավելվածը Ձեր աշխատանքային գործիքն է դաշտում. այն օգնում է պլանավորել այցերը, գրանցել չեք-ինները, ընդունել պատվերներ, գրանցել վճարումները և տեսնել Ձեր հաճախորդների պարտքերը։ Այն աշխատում է հեռախոսի վրա որպես հավելված (PWA), ինտերնետի բացակայության դեպքում էլ։"),
            ("ol", [
                "Բացեք հավելվածի հղումը հեռախոսի զննարկիչում (iPhone՝ Safari, Android՝ Chrome)։",
                "Մուտքագրեք Ձեր էլ. փոստը և գաղտնաբառը, որ Ձեզ տվել է ադմինիստրատորը, ապա սեղմեք «Մուտք»։",
                "Տեղադրեք հավելվածը հիմնական էկրանին՝ iPhone-ում «Share → Add to Home Screen», Android-ում՝ «Install»։ Այդպես այն բացվում է մեկ հպումով և ավելի արագ է աշխատում։",
                "Անմիջապես փոխեք գաղտնաբառը՝ Կարգավորումներ → Փոխել գաղտնաբառը։",
            ]),
            ("tip", "Լեզուն (Հայերեն/English) և մութ ռեժիմը փոխվում են Կարգավորումներում։ Եթե հավելվածը «ճիշտ չի թարմացվել», Կարգավորումներում սեղմեք «Ստուգել թարմացումները»։"),
        ],
    ),
    dict(
        id="nav",
        title="2. Ինչպես կողմնորոշվել",
        blocks=[
            ("p", "Ներքևի վահանակում հինգ հիմնական բաժին կա։ Կենտրոնի մեծ կլոր կոճակը Քարտեզն է՝ ամենաշատ օգտագործվող էկրանը։"),
            ("table", [
                ["Բաժին", "Ինչի համար է"],
                ["Գլխավոր", "Հաջորդ այցը, շաբաթվա առաջընթացը, արագ գործողությունների կոճակները"],
                ["Ակտիվություն", "Ձեր կատարած այցերի պատմությունը և որոնում ըստ ժամանակի, մարզի, արդյունքի"],
                ["Քարտեզ", "Բոլոր Ձեր հաճախորդները քարտեզի վրա, չեք-ին, նոր հաճախորդի ավելացում"],
                ["Հաճախորդներ", "Ցանկ՝ որոնմամբ, ֆիլտրերով և դասավորությամբ"],
                ["Պատվերներ", "Ստեղծված պատվերների ցանկ և կարգավիճակներ"],
            ]),
            ("p", "Վերևի աջ անկյունում զանգակն է (ծանուցումներ) և ցանկի պատկերակը՝ այնտեղից բացվում են Կարգավորումները։ Գլխավոր էկրանի «Արագ գործողություններ» ցանցը տանում է մնացած բոլոր գործիքներին՝ Երթուղու պլաններ, Վճարումներ, Կանխիկ ծախս, Ապրանքներ, Թիմի կատարողական, Հաշվետվություն, Պարտքի մնացորդներ, Բոնուսներ։"),
            ("tip", "Ձեր տեսած ամեն ինչ միայն Ձերն է. վաճառքի մենեջերը տեսնում է միայն իրեն նշանակված հաճախորդները, իր այցերը, պատվերները և վճարումները։"),
        ],
    ),
    dict(
        id="day",
        title="3. Աշխատանքային օրը մեկ հայացքով",
        blocks=[
            ("ol", [
                "Առավոտյան բացեք Գլխավորը. տեսեք «Հաջորդ այցելություն» քարտը և շաբաթվա առաջընթացը։",
                "Անհրաժեշտության դեպքում ստուգեք Երթուղու պլանը՝ ո՞ր հաճախորդներին եք այցելում այսօր։",
                "Հաճախորդի մոտ գտնվելիս Քարտեզից կամ Գլխավորից սեղմեք «Չեք-ին» և լրացրեք այցի արդյունքը։",
                "Եթե հաճախորդն ուզում է պատվեր՝ ստեղծեք այն նույն էկրանից («Նոր պատվեր»)։",
                "Եթե վճարում եք ստացել՝ գրանցեք Վճարումներում և հետո հանձնեք կանխիկը տնօրենին (Կանխիկի հանձնումներ)։",
                "Օրվա վերջում նայեք Ակտիվությունը և Հաշվետվությունները՝ այցերն ու նոր հաճախորդները ճիշտ են գրանցվել։",
            ]),
            ("note", "Այցը համարվում է կատարված միայն չեք-ինից հետո. առանց չեք-ինի շաբաթվա առաջընթացը չի աճի։"),
        ],
    ),
    dict(
        id="map",
        title="4. Քարտեզ և նոր հաճախորդ",
        img="addcust",
        cap="Նոր հաճախորդի կետի նշում",
        blocks=[
            ("p", "Քարտեզի վրա Ձեր հաճախորդները նշված են կետերով (պինով)։ Կանաչ՝ մեր հաճախորդներ, կարմիր՝ հավանական (դեռ ERP-ի հետ չկապված), կանաչ նշանը՝ այցելված։ «i» կոճակը բացում է նշանների բացատրությունը։ Վերևի որոնումը գտնում է հաճախորդին կամ հասցեն։"),
            ("p", "Ներքևի կանաչ գոտին ցույց է տալիս Ձեզնից ամենամոտ հաճախորդին և հեռավորությունը. կոճակը սեղմելով կատարվում է չեք-ին։ Աջ կողմի կոճակներով կարող եք մոտեցնել/հեռացնել, կենտրոնանալ Ձեր դիրքի վրա, բացել օրվա պլանը և ֆիլտրերը։"),
            ("h", "Նոր հաճախորդի ավելացում"),
            ("ol", [
                "Սեղմեք կապույտ «Նոր հաճախորդ» կոճակը (քարտեզի ներքևի աջ անկյուն) կամ Գլխավորի «Ավելացնել նոր հաճախորդ»։",
                "Հպեք քարտեզին այնտեղ, որտեղ գտնվում է հաճախորդը, և հաստատեք տեղադրությունը։",
                "Լրացրեք անունը, տեսակը (Յուղման կետ, Խանութ, Ավտոսերվիս, Այլ), հեռախոսը և հասցեն։ Մարզը, ենթամարզը և վաճառքի ուղղությունը լրացվում են ինքնաբերաբար։",
                "Պահպանեք։ Հաճախորդը ստանում է «Հավանական» մակարդակ, քանի դեռ նրա ERP համարը չի մուտքագրվել։",
            ]),
            ("tip", "Նոր հաճախորդները երևում են «Հաշվետվություն → Նոր հաճախորդներ» ցանկում՝ միայն Ձերը։"),
        ],
    ),
    dict(
        id="customers",
        title="5. Հաճախորդներ",
        img="customers",
        cap="Հաճախորդների ցանկ",
        blocks=[
            ("p", "Վերևի չորս քարտերը ֆիլտրում են ցանկը՝ Բոլորը, Այցելած, Բաց թողած (ժամկետանց), Չայցելած։ Որոնման դաշտը գտնում է անունով, ERP համարով, հեռախոսով, հասցեով, սոցիալական հղումներով, ինչպես նաև ըստ այցերում գրանցված ապրանքների՝ օր.՝ «կեղծ castrol», «usa castrol», «mobil»։ Արդյունքի տակ երևում է, թե ինչու է կետը համընկել (օր.՝ «Կեղծ Castrol · Oct 6»)։"),
            ("ul", [
                "Քարտի պատկերակը ցույց է տալիս հաճախորդի տեսակը, իսկ գույնը՝ մակարդակը (ոսկե, արծաթե, բրոնզե)։",
                "«Այցելված է այսօր» / «Վերջին այց» տողը ցույց է տալիս վերջին այցի ժամանակը։",
                "Վերևի աջ «+» կոճակը ավելացնում է նոր հաճախորդ, քարտի պատկերակը՝ ցույց/թաքցնում է պարտքը։",
            ]),
            ("h", "Ֆիլտրեր և դասավորություն"),
            ("ul", [
                "Մարզ → ենթամարզ. բացվող ծառ՝ եռաստիճան նշումներով (ամբողջ մարզ, մասամբ կամ ոչինչ)։",
                "Հաճախորդի տեսակ և մակարդակ. նույն տիպի ծառ՝ ըստ տեսակի (Ավտոսերվիս, Խանութ, Յուղման կետ) և մակարդակի (Ոսկե, Արծաթե, Բրոնզե, Հավանական)։",
                "Ապրանքներ դարակում. նույն տիպի ծառ՝ ըստ ապրանքանիշի և գրանցված վիճակի (կեղծ, ԱՄՆ/Դուբայի/ՌԴ Castrol, Lotos, Royal, մրցակիցներ). ցույց է տալիս այն կետերը, որտեղ որևէ այց գրանցել է ընտրվածը։",
                "Դասավորություն՝ անունով, վերջին այցով, վերջին ավելացվածով, հեռավորությամբ. նույն կետին կրկին հպելը շրջում է կարգը։",
            ]),
        ],
    ),
    dict(
        id="customer_card",
        title="6. Հաճախորդի քարտ",
        img="customer",
        cap="Հաճախորդի քարտ",
        blocks=[
            ("p", "Քարտը ցույց է տալիս վայրը, հեռախոսը, ուղղությունը և Ձեզ նշանակված մենեջերին, այցի հաճախականությունը, վճարման պայմանները, ամսվա վաճառքը, չվճարված պարտքը (ERP-ով կապված հաճախորդների համար), վերջին պատվերն ու այցը։"),
            ("ul", [
                "Կոճակների շարքը (Չեք-ին, Նավարկել, Պատվերներ, Նոր պատվեր, Նկարներ) գտնվում է «Հաջորդ այցելություն» քարտից վերև։ «Ապրանքներ կետում» բաժնում երևում են պիտակներ՝ ինչ է գրանցվել այցերում (կեղծ Castrol, ԱՄՆ Castrol, Lotos, Royal, մրցակիցներ). պիտակը փոխվում է միայն երբ նոր այցը կրկին գրանցում է այդ ապրանքանիշը, այլապես մնում է նույնը։",
                "Այցելությունների պատմությունը ցույց է տալիս նախկին այցերն ու նրանց արդյունքը։",
                "Փոխելու համար սեղմեք մատիտի պատկերակը։ Մենեջերի փոփոխությունները ուղարկվում են ադմինիստրատորին հաստատման («Փոփոխությունները ուղարկվեցին»)։",
                "Մակարդակը (Բրոնզե/Արծաթե/Ոսկե) հաճախորդի ERP տվյալներից է և ավտոմատ թարմացվում է Excel ֆայլով. ձեռքով չի փոխվում։",
            ]),
            ("note", "Պարտքը, պատվերների և վճարումների պատմությունը երևում են միայն Ձեզ նշանակված ERP-ով կապված հաճախորդների համար։"),
        ],
    ),
    dict(
        id="checkin",
        title="7. Չեք-ին (այցելության գրանցում)",
        img="checkin",
        cap="Չեք-ինի էջ",
        blocks=[
            ("ol", [
                "Հաճախորդի մոտ սեղմեք «Չեք-ին»։ Հավելվածը ստուգում է Ձեր GPS դիրքը (ճշգրտությունը ցույց է տրվում «±մ»)։",
                "Եթե հեռավորությունը թույլատրելի շառավղի մեջ է, տեսնում եք կանաչ հաստատում («Դուք գտնվում եք …մ հաճախորդից»)։",
                "Նշեք այցի արդյունքը (մեկ կամ մի քանիսը)՝ Պատվեր է կատարվել, Պատվեր չկա, Վճարում է ստացվել (մուտքագրեք գումարը), Կրկին այցելել, Տեսականու ստուգում, Առաքվել է ապրանք, Բողոք, Այլ։",
                "Նշեք, թե որ ապրանքանիշերն են առկա կետում (Castrol, Lotos, Royal, մրցակիցներ)։",
                "Ցանկության դեպքում ավելացրեք նշում և նկար (Բարձր որակ՝ օր.՝ գնապիտակների համար), ապա սեղմեք «Ուղարկել չեք-ինը»։",
            ]),
            ("tip", "Ինտերնետի բացակայության դեպքում չեք-ինը պահվում է հեռախոսում («Օֆլայն — չեք-ին սպասում է համաժամեցման») և ինքնաբերաբար ուղարկվում է կապը վերականգնվելիս։"),
            ("note", "Եթե Դուք հաճախորդից թույլատրելի շառավղից հեռու եք, այցը կգրանցվի, բայց տեղադրությունը կնշվի որպես չհաստատված։ Մոտեցեք հաճախորդին կամ սպասեք GPS-ի ճշգրտմանը։"),
        ],
    ),
    dict(
        id="orders",
        title="8. Պատվերներ",
        img="order",
        cap="Նոր պատվեր",
        blocks=[
            ("h", "Պատվերի ստեղծում"),
            ("ol", [
                "Հաճախորդի քարտում կամ չեք-ինի ժամանակ սեղմեք «Նոր պատվեր»։",
                "Ընտրեք ապրանքանիշը (օր.՝ Castrol), ապա ընտրեք կատեգորիան (Շարժիչի յուղ, Տրանսմիսիա, Հիդրավլիկ, Հակասառեցնող, Քսուկ, EV հեղուկներ, Այլ) կամ որոնեք անունով։",
                "Սեղմեք «Ավելացնել» և կարգավորեք քանակը։ Գինը վերցվում է հաճախորդի մակարդակից. բրոնզեի համար՝ բրոնզե, արծաթի համար՝ արծաթե, ոսկեի համար՝ ոսկե գին (ոսկե հաճախորդների համար կարող են լինել անհատական գներ)։ Եթե մակարդակի գինը դատարկ է, վերցվում է հաջորդ ցածր մակարդակինը։",
                "Սեղմեք «Պահպանել պատվերը»։ Եթե հաճախորդի ERP համարը դեռ չկա, պատվերը մնում է «Սևագիր»՝ մուտքագրեք ERP համարը, որպեսզի ուղարկվի։",
            ]),
            ("p", "Զեղչը (% կամ ֆիքսված գումար) պահանջում է տնօրենի հաստատում. մինչև հաստատումը պատվերը չի կարող կատարվել։ Լրիվ գնով պատվերները դա չեն պահանջում։"),
            ("h", "Կարգավիճակներ"),
            ("table", [
                ["Կարգավիճակ", "Նշանակություն"],
                ["Ուղարկված", "Ձեր պատվերը ստեղծված է և սպասում է հաստատման"],
                ["Հաստատված", "Տնօրենը/ղեկավարությունը հաստատել է"],
                ["Փաթեթավորված և դուրս գրված", "Պահեստը պատրաստել է և դուրս է գրել"],
                ["Առաքված", "Պատվերը հասցվել է հաճախորդին"],
                ["Սևագիր", "Դեռ չի ուղարկվել (օր.՝ ERP համար չկա). ցուցադրվում է վերջում"],
            ]),
            ("tip", "«Պատվերներ» բաժնում կարգավիճակի ֆիլտրերը հերթականությամբ են (Բոլորը → Ուղարկված → … → Սևագիր)։ Սևագրերը մշտապես ամենավերջին կետն են, որ ակտիվ պատվերները չծածկվեն։"),
        ],
    ),
    dict(
        id="orders_list",
        title="9. Պատվերների ցանկ",
        img="orders",
        cap="Կարգավիճակի ֆիլտրեր",
        blocks=[
            ("p", "Վերևի շարքում կարգավիճակի կոճակներն են (կարող եք շարժել ձախ-աջ), դրանց տակ՝ որոնումը և մարզի/ուղղության ֆիլտրը։ Յուրաքանչյուր ամսվա վերնագրում երևում են ընդհանուր գումարը, լիտրերը և պատվերների քանակը։"),
            ("ul", [
                "Սեղմեք պատվերին՝ տեսնելու ապրանքները, գները, կարգավիճակի պատմությունը։",
                "Սևագիր պատվերը կարող եք լրացնել և ուղարկել հետո։",
                "Վերևի աջ կոճակը ստեղծում է նոր պատվեր։",
            ]),
        ],
    ),
    dict(
        id="payments",
        title="10. Վճարումներ և կանխիկի հանձնում",
        img="payment_new",
        cap="Վճարման գրանցում",
        blocks=[
            ("p", "Երբ հաճախորդը վճարում է Ձեզ, վճարումը պետք է գրանցել հավելվածում։"),
            ("ol", [
                "Գլխավոր → Վճարումներ → «+»։",
                "Ընտրեք հաճախորդին, մուտքագրեք ստացված գումարը (ՀՀ դրամ, ամբողջ թվով), ամսաթիվը և ըստ ցանկության նշում։",
                "Սեղմեք «Ուղարկել վճարումը»։ Վճարումը հայտնվում է «Սպասող» կարգավիճակով։",
            ]),
            ("p", "Կարգավիճակները՝ Սպասող (սպասում է հաստատման), Հաստատված, Մերժված։ Հաստատում է հաշվապահը։"),
            ("h", "Կանխիկի հանձնում"),
            ("p", "Եթե վճարումը կանխիկ էր, սեղմեք «Կանխիկի հանձնումներ»՝ նշեք, թե որ վճարումների կանխիկն եք հանձնում և ում (վաճառքի տնօրենին)։ Ստացողը հաշվում է գումարը և հաստատում ստացումը. կանխիկը հետո անցնում է հաշվապահին։ Հաստատված ստացումը փակում է Ձեր պարտավորությունը։"),
            ("note", "Կանխիկ ծախսերը (վառելիք, ճանապարհ և այլն) գրանցվում են առանձին՝ Գլխավոր → Կանխիկ ծախս → «Ավելացնել ծախս»։"),
        ],
    ),
    dict(
        id="reports",
        title="11. Հաշվետվություններ (Ձեր տվյալները)",
        img="reports",
        cap="Հաշվետվությունների ցանկ",
        blocks=[
            ("p", "Գլխավոր → «Հաշվետվություն»։ Վաճառքի մենեջերի համար հասանելի են երեք հաշվետվություն. դրանք ցույց են տալիս ՄԻԱՅՆ Ձեր տվյալները՝ մյուս մենեջերների տվյալները երբեք չեն երևում։"),
            ("table", [
                ["Հաշվետվություն", "Ինչ է ցույց տալիս"],
                ["Նոր հաճախորդներ", "Ձեր ավելացրած հաճախորդները ընտրված ժամանակահատվածում (այս ամիս, մարզ, տեսակ, մակարդակ)"],
                ["Այցեր", "Ձեր կատարած այցերը՝ ըստ մարզի, կատեգորիայի, ժամանակահատվածի և արդյունքի"],
                ["Հաճախորդների պարտք", "Ձեզ նշանակված հաճախորդների չվճարված մնացորդները՝ ըստ ժամկետանցության (0–30, 31–60, 61–90 օր և այլն)"],
            ]),
            ("p", "Յուրաքանչյուր հաշվետվության վերևում ֆիլտրեր կան. ընտրեք ժամանակահատվածը և մարզը՝ ցանկը անմիջապես թարմացվում է։"),
        ],
    ),
    dict(
        id="debt",
        title="12. Պարտքի մնացորդներ",
        img="rep_debt",
        cap="Հաճախորդների պարտք",
        blocks=[
            ("p", "«Հաճախորդների պարտք»-ը ցույց է տալիս Ձեզ նշանակված հաճախորդների պարտքը՝ ընդհանուր գումար, պարտք ունեցող հաճախորդների քանակ, բաժանում ըստ ժամկետանցության և հաճախորդների ցանկ՝ իրենց վերջին վճարմամբ։"),
            ("ul", [
                "Վերևում նշված է տվյալների թարմացման ժամանակը («Castrol տվյալները՝ …»)։ Տվյալները գալիս են ընկերության Excel ֆայլից, ուստի կարող են մի քանի ժամ/օր հետ լինել։",
                "«Միայն պարտք» ֆիլտրը թաքցնում է նրանց, ում պարտքը 0 է։",
                "Եթե հաճախորդի վրա պարտք կա, այցի ժամանակ հիշեցրեք վճարման մասին և անմիջապես գրանցեք ստացված վճարումը։",
            ]),
            ("tip", "Ժամկետանցությամբ ցանկը (61–90 օր և ավելի) ամենաառաջնային հաճախորդներն են հետևելու համար։"),
        ],
    ),
    dict(
        id="products",
        title="13. Ապրանքներ և գնացուցակ",
        img="products",
        cap="Ապրանքների ցանկ",
        blocks=[
            ("p", "Գլխավոր → Ապրանքներ։ Ցույց են տրվում միայն ակտիվ ապրանքները (որոնք ներկայումս վաճառվում են). անակտիվները թաքնված են։ Ապրանքները դասավորված են ըստ ապրանքանիշի, ընտանիքի, մածուցիկության և չափի։"),
            ("ul", [
                "Որոնեք ապրանքը անունով, ֆիլտրեք ապրանքանիշերով ու կատեգորիաներով։",
                "Ցուցադրվում է մանրածախ գինը։ Ձեր հաճախորդի մակարդակի գինը (բրոնզե/արծաթե/ոսկե) տեսնում եք պատվեր ստեղծելիս։",
                "Ապրանքներն ընտրելով կարող եք կիսվել գնացուցակով հաճախորդի հետ (վերևի աջ կոճակներ)։",
            ]),
        ],
    ),
    dict(
        id="plans",
        title="14. Երթուղու պլաններ",
        img="plans",
        cap="Շաբաթվա պլան",
        blocks=[
            ("p", "Գլխավոր → Երթուղու պլաններ։ Ընտրեք շաբաթվա օրը՝ տեսնելու/ընտրելու, թե Ձեր որ հաճախորդներին եք այցելում այդ օրը՝ ամեն շաբաթ կրկնվող։ «Չպլանավորված» ցանկում երևում են այն հաճախորդները, որոնք դեռ ոչ մի օրվա մեջ չեն։"),
            ("ul", [
                "Օրվա պլանը երևում է Գլխավորում «Հաջորդ այցելություն» քարտում և շաբաթվա առաջընթացում։",
                "Քարտեզում «Պլանավորել օրը» կոճակով կարող եք ընտրել հաճախորդներ ըստ ուղղության/մարզի/ենթամարզի (բացվող ծառով)։",
                "Պլանը կարող է պահանջել հաստատում. կարգավիճակը երևում է («Սպասում է հաստատման» / «Հաստատված»)։",
            ]),
        ],
    ),
    dict(
        id="perf",
        title="15. Թիմի կատարողական և Բոնուսներ",
        img="bonuses",
        cap="Բոնուսներ",
        blocks=[
            ("p", "Թիմի կատարողական. եթե Ձեզ նշանակված է վաճառքի ուղղություն, այստեղ տեսնում եք վաճառքի և հավաքագրման (կոլեկցիա) արդյունքները՝ պլանի համեմատ։ Եթե ուղղություն նշանակված չէ, էջը ասում է, որ հասանելի է միայն նշանակված ուղղությամբ մենեջերներին։"),
            ("p", "Բոնուսներ. եթե ադմինիստրատորը միացրել է մոդուլը, տեսնում եք Ձեր միավորները, մակարդակը, ակտիվ մարտահրավերները (օր.՝ այցերի կամ վաճառքի նպատակներ), պտուղների նշանները և ամսվա առաջատարներին։"),
            ("tip", "Միավորները ստացվում են ճիշտ գրանցված այցերի համար. համոզվեք, որ ամեն այց գրանցում եք չեք-ինով։"),
        ],
    ),
    dict(
        id="settings",
        title="16. Կարգավորումներ",
        img="settings",
        cap="Կարգավորումներ",
        blocks=[
            ("ul", [
                "Հեռախոս. Ձեր կոնտակտային համարը։",
                "Մուգ ռեժիմ և Լեզու (Հայերեն/English)։",
                "Խնայողական ռեժիմ. թուլացնում է անիմացիաները թույլ հեռախոսների համար։",
                "Push ծանուցումներ. թույլատրեք՝ պատվերների կարգավիճակի, պլանների և հիշեցումների համար։",
                "Համաժամեցում. ցույց է տալիս համաժամեցման վիճակը։ «Թարմացնել տվյալները» և «Թարմացնել ապրանքացանկը» կոճակները բեռնում են թարմ տվյալները։",
                "Օֆլայն պահեստ. որքան տվյալ է պահված հեռախոսում։",
                "Անվտանգություն. Փոխել գաղտնաբառը, Սեսիաների կառավարում (դուրս գալ մյուս սարքերից)։",
                "Օգտագործման ուղեցույց. այս փաստաթուղթը։ «Ստուգել թարմացումները»՝ տեղադրում է հավելվածի նոր տարբերակը։",
            ]),
        ],
    ),
    dict(
        id="faq",
        title="17. Հաճախակի հարցեր և խնդիրներ",
        blocks=[
            ("table", [
                ["Խնդիր", "Ինչ անել"],
                ["Քարտեզը չի բացվում", "Ստուգեք ինտերնետը, սեղմեք «Կրկին փորձել»։ Համակարգչով դիտելիս թարմացրեք էջը (Ctrl/Cmd+Shift+R)։"],
                ["Տեղադրությունը չի հաստատվում", "Մոտեցեք հաճախորդին, սպասեք GPS-ի ճշգրտմանը (±մ փոքրանա), թույլատրեք տեղադրության հասանելիությունը։"],
                ["Հաճախորդը չեմ տեսնում", "Երևում են միայն Ձեզ նշանակվածները։ Եթե կարծում եք՝ պետք է տեսնեիք, դիմեք վաճառքի տնօրենին։"],
                ["Պատվերը մնում է «Սևագիր»", "Հաճախորդի ERP համարը բացակայում է. մուտքագրեք այն (կամ խնդրեք հաշվապահին) և ուղարկեք պատվերը։"],
                ["Գինը ցածր/բարձր է թվում", "Գինը կախված է հաճախորդի մակարդակից (բրոնզե/արծաթե/ոսկե)։ Մակարդակը փոխվում է Excel ֆայլով՝ ոչ ձեռքով։"],
                ["Պարտքը չի համընկնում", "Պարտքի տվյալները Excel-ից են և կարող են հետ լինել. նայեք «տվյալների թարմացման» ժամանակին։"],
                ["Հավելվածը «հին» է", "Կարգավորումներ → Ստուգել թարմացումները։"],
                ["Ինտերնետ չկա", "Շարունակեք աշխատել. չեք-ինները և պատվերները պահվում են և ուղարկվում կապը վերականգնվելիս։"],
            ]),
            ("p", "Այլ հարցերի դեպքում դիմեք Ձեր վաճառքի տնօրենին կամ ադմինիստրատորին։"),
        ],
    ),
    dict(
        id="roles",
        title="18. Ով ինչ է տեսնում",
        blocks=[
            ("table", [
                ["Դեր", "Հիմնական հնարավորություններ"],
                ["Վաճառքի մենեջեր (Դուք)", "Միայն իր հաճախորդները, այցերը, պատվերները, վճարումները. իր հաշվետվությունները՝ նոր հաճախորդներ, այցեր, պարտք"],
                ["Վաճառքի տնօրեն", "Բոլոր մենեջերների տվյալները, պատվերների հաստատում, հաճախորդների վերանշանակում, երթուղիների պլանավորում"],
                ["Գործադիր/Օպերացիոն տնօրեն", "Լիարժեք դիտում և հաստատումներ"],
                ["Հաշվապահ", "Վճարումների հաստատում, ապրանքների գներ, ERP տվյալներ"],
                ["Պահեստ / Առաքում", "Պատվերների փաթեթավորում և առաքում"],
                ["Ադմինիստրատոր", "Օգտատերեր, կարգավորումներ, լիարժեք մուտք"],
            ]),
        ],
    ),
]

# ----------------------------------------------------------------- English
SECTIONS["en"] = [
    dict(
        id="start",
        title="1. Getting started",
        img="home",
        cap="Home screen",
        blocks=[
            ("p", "The KAD Motors Field Visits app is your tool in the field: plan visits, check in, take orders, record payments and see your customers' debts. It installs on your phone as an app (PWA) and keeps working with no internet."),
            ("ol", [
                "Open the app link in your phone browser (Safari on iPhone, Chrome on Android).",
                "Enter the email and password your administrator gave you and tap “Log in”.",
                "Add the app to your home screen: iPhone “Share → Add to Home Screen”, Android “Install”. It then opens in one tap and runs faster.",
                "Change your password right away: Settings → Change password.",
            ]),
            ("tip", "Language (Armenian/English) and dark mode are in Settings. If the app looks out of date, tap “Check for updates” in Settings."),
        ],
    ),
    dict(
        id="nav",
        title="2. Finding your way around",
        blocks=[
            ("p", "The bottom bar has five main sections. The big round button in the middle is the Map, the screen you will use most."),
            ("table", [
                ["Section", "What it is for"],
                ["Home", "Next visit, this week's progress, quick-action buttons"],
                ["Activity", "History of your visits, searchable by time, region and outcome"],
                ["Map", "All your customers on a map, check-in, add a new customer"],
                ["Customers", "A list with search, filters and sorting"],
                ["Orders", "Your orders and their statuses"],
            ]),
            ("p", "Top right: the bell (notifications) and the menu icon, which opens Settings. The “Quick actions” grid on Home leads to everything else: Route Plans, Payments, Cash expense, Products, Team Performance, Reports, Debt Balances, Bonuses."),
            ("tip", "Everything you see is yours: a sales manager only sees customers assigned to them, plus their own visits, orders and payments."),
        ],
    ),
    dict(
        id="day",
        title="3. Your day at a glance",
        blocks=[
            ("ol", [
                "In the morning open Home: check the “Next visit” card and this week's progress.",
                "Check your Route Plan if needed: which customers are you visiting today?",
                "At the customer, tap “Check in” (Map or Home) and record the visit outcome.",
                "If the customer wants to order, create the order from the same screen (“New order”).",
                "If you received a payment, record it under Payments and later hand the cash over (Cash handovers).",
                "At the end of the day look at Activity and Reports to make sure visits and new customers were recorded.",
            ]),
            ("note", "A visit only counts after the check-in. Without a check-in your weekly progress will not move."),
        ],
    ),
    dict(
        id="map",
        title="4. Map and new customers",
        img="addcust",
        cap="Placing a new customer",
        blocks=[
            ("p", "Your customers appear on the map as pins. Green: our customers; red: potential (not yet linked to the ERP); the green tick means visited. The “i” button explains the symbols. The search box at the top finds a customer or an address."),
            ("p", "The green bar at the bottom shows the nearest customer and the distance; tap its button to check in. The buttons on the right zoom, centre on your position, open the day plan and the filters."),
            ("h", "Adding a new customer"),
            ("ol", [
                "Tap the blue “New customer” button (bottom right of the map) or “Add new customer” on Home.",
                "Tap the map where the customer is and confirm the location.",
                "Fill in the name, type (Oil change point, Shop, Workshop, Other), phone and address. Region, subregion and sales channel fill in automatically.",
                "Save. The customer starts as “Potential” until an ERP number is entered.",
            ]),
            ("tip", "New customers show up in Reports → New customers, only yours."),
        ],
    ),
    dict(
        id="customers",
        title="5. Customers",
        img="customers",
        cap="Customer list",
        blocks=[
            ("p", "The four cards at the top filter the list: All, Visited, Overdue, Not visited. The search box matches name, ERP ID, phone, address, social links and the products recorded at visits, e.g. 'fake castrol', 'usa castrol', 'mobil'. The card shows why it matched (e.g. 'Fake Castrol · Oct 6')."),
            ("ul", [
                "A card's icon shows the customer type; its colour shows the tier (gold, silver, bronze).",
                "The “Visited today” / “Last visit” line shows when you were last there.",
                "The “+” button top right adds a customer; the card icon shows/hides debt.",
            ]),
            ("h", "Filters and sorting"),
            ("ul", [
                "Region → subregion: an expandable tree with tri-state checkboxes (whole region, partly, none).",
                "Customer type and tier: the same kind of tree, by type (Workshop, Shop, Oil change point) and tier (Gold, Silver, Bronze, Potential).",
                "Products on the shelf: the same kind of tree, by brand and recorded status (fake, USA/Dubai/Russian Castrol, Lotos, Royal, competitors); shows shops where any visit recorded the selected products.",
                "Sort by name, last visit, last added or distance; tap the same option again to reverse the order.",
            ]),
        ],
    ),
    dict(
        id="customer_card",
        title="6. The customer card",
        img="customer",
        cap="Customer card",
        blocks=[
            ("p", "The card shows the location, phone, channel and assigned manager, visit frequency, payment terms, this month's sales, unpaid debt (for ERP-linked customers), and the last order and visit."),
            ("ul", [
                "The button row (Check in, Navigate, Orders, New order, Photos) sits above the 'Next visit' card. 'Products at this shop' shows chips of what visits recorded (fake Castrol, USA Castrol, Lotos, Royal, competitors); a chip changes only when a new visit records that brand again, otherwise it stays.",
                "The visit history lists previous visits and their outcomes.",
                "To change details tap the pencil. A manager's changes go to an administrator for approval (“Your changes were sent…”).",
                "The tier (Bronze/Silver/Gold) comes from the company's ERP data and is refreshed automatically from the Excel file; it is not edited by hand.",
            ]),
            ("note", "Debt and order/payment history are visible only for ERP-linked customers assigned to you."),
        ],
    ),
    dict(
        id="checkin",
        title="7. Check-in (recording a visit)",
        img="checkin",
        cap="Check-in page",
        blocks=[
            ("ol", [
                "At the customer tap “Check in”. The app verifies your GPS position (accuracy shown as “±m”).",
                "If you are within the allowed radius you see a green confirmation (“You are …m from the customer”).",
                "Select the visit outcome (one or several): Order placed, No order, Payment collected (enter the amount), Revisit, Assortment check, Products delivered, Complaint, Other.",
                "Mark which brands are available at the point (Castrol, Lotos, Royal, competitors).",
                "Optionally add a note and a photo (High quality for price tags), then tap “Send check-in”.",
            ]),
            ("tip", "With no internet the check-in is stored on the phone (“Offline — check-in waiting to sync”) and is sent automatically when the connection returns."),
            ("note", "If you are outside the allowed radius the visit is still saved, but its location is marked as not verified. Move closer to the customer or wait for the GPS accuracy to improve."),
        ],
    ),
    dict(
        id="orders",
        title="8. Orders",
        img="order",
        cap="New order",
        blocks=[
            ("h", "Creating an order"),
            ("ol", [
                "On the customer card, or during a check-in, tap “New order”.",
                "Pick the brand (e.g. Castrol), then a category (Engine oil, Transmission, Hydraulic, Antifreeze, Grease, EV fluids, Other) or search by name.",
                "Tap “Add” and set the quantity. The price follows the customer's tier: bronze, silver or gold price (gold customers can have individually agreed prices). If a tier price is empty, the next lower tier's price is used.",
                "Tap “Save order”. If the customer has no ERP ID yet the order stays a “Draft”: enter the ERP ID to submit it.",
            ]),
            ("p", "A discount (% or fixed amount) needs the director's approval; until then the order cannot be fulfilled. Orders at full price do not."),
            ("h", "Statuses"),
            ("table", [
                ["Status", "Meaning"],
                ["Submitted", "Your order is created and waits for confirmation"],
                ["Confirmed", "Approved by management"],
                ["Packed / Stock out", "Warehouse has prepared and released it"],
                ["Delivered", "Handed over to the customer"],
                ["Draft", "Not submitted yet (e.g. no ERP ID); always shown last"],
            ]),
            ("tip", "In the Orders tab the status chips run in order (All → Submitted → … → Draft). Drafts are always the last chip so active orders stay up front."),
        ],
    ),
    dict(
        id="orders_list",
        title="9. The orders list",
        img="orders",
        cap="Status filters",
        blocks=[
            ("p", "The top row holds the status chips (swipe sideways); below are search and the region/channel filter. Each month header shows the total amount, litres and number of orders."),
            ("ul", [
                "Tap an order to see its items, prices and status history.",
                "A draft order can be completed and submitted later.",
                "The button top right creates a new order.",
            ]),
        ],
    ),
    dict(
        id="payments",
        title="10. Payments and cash handovers",
        img="payment_new",
        cap="Recording a payment",
        blocks=[
            ("p", "When a customer pays you, record the payment in the app."),
            ("ol", [
                "Home → Payments → “+”.",
                "Choose the customer, enter the amount received (AMD, whole number), the date and an optional note.",
                "Tap “Submit payment”. It appears as “Awaiting approval”.",
            ]),
            ("p", "Statuses: Awaiting approval, Approved, Rejected. The accountant approves."),
            ("h", "Cash handovers"),
            ("p", "If the payment was cash, tap “Cash handovers”, choose which payments' cash you are handing over and to whom (your sales director). The recipient counts the money and confirms receipt; the cash then moves on to the accountant. A confirmed receipt closes your responsibility for it."),
            ("note", "Cash expenses (fuel, travel, …) are recorded separately: Home → Cash expense → “Add expense”."),
        ],
    ),
    dict(
        id="reports",
        title="11. Reports (your own data)",
        img="reports",
        cap="Report list",
        blocks=[
            ("p", "Home → Reports. A sales manager has three reports. They show ONLY your own data; other managers' data never appears."),
            ("table", [
                ["Report", "What it shows"],
                ["New customers", "Customers you added in the chosen period (this month, region, type, tier)"],
                ["Visits", "The visits you made, by region, category, period and outcome"],
                ["Customer debt", "Unpaid balances of the customers assigned to you, by age (0–30, 31–60, 61–90 days, …)"],
            ]),
            ("p", "Each report has filters at the top: choose the period and region and the list updates immediately."),
        ],
    ),
    dict(
        id="debt",
        title="12. Debt balances",
        img="rep_debt",
        cap="Customer debt",
        blocks=[
            ("p", "“Customer debt” shows the debts of the customers assigned to you: the total, the number of customers with a debt, a split by age and a customer list with the last payment."),
            ("ul", [
                "The top line shows when the data was last refreshed (“Castrol data as of …”). It comes from the company Excel file, so it can lag by hours or a day.",
                "The “Debt only” filter hides customers whose balance is 0.",
                "When a customer owes money, remind them during the visit and record any payment you receive right away.",
            ]),
            ("tip", "Watch the oldest buckets (61–90 days and beyond) first."),
        ],
    ),
    dict(
        id="products",
        title="13. Products and pricelist",
        img="products",
        cap="Product list",
        blocks=[
            ("p", "Home → Products. Only active products (currently on sale) are listed; inactive ones are hidden. Products are ordered by brand, family, viscosity and size."),
            ("ul", [
                "Search by name, filter by brand and category.",
                "The retail price is shown here. The price for your customer's tier (bronze/silver/gold) appears when you create an order.",
                "You can select products and share the pricelist with a customer (buttons top right).",
            ]),
        ],
    ),
    dict(
        id="plans",
        title="14. Route plans",
        img="plans",
        cap="Weekly plan",
        blocks=[
            ("p", "Home → Route Plans. Pick a weekday to see/choose which of your customers you visit that day, every week. The “Unplanned” list shows customers not on any day yet."),
            ("ul", [
                "Today's plan appears on Home in the “Next visit” card and in the weekly progress.",
                "On the Map, “Plan day” lets you choose customers by channel/region/subregion (expandable tree).",
                "A plan may need approval; its status is shown (“Awaiting approval” / “Approved”).",
            ]),
        ],
    ),
    dict(
        id="perf",
        title="15. Team Performance and Bonuses",
        img="bonuses",
        cap="Bonuses",
        blocks=[
            ("p", "Team Performance: if you have a sales channel assigned, you see sales and collections against plan. If not, the page explains it is only available to managers with an assigned channel."),
            ("p", "Bonuses: when the administrator has enabled the module you see your points, level, active challenges (e.g. visit or sales goals), fruit badges and the month's leaders."),
            ("tip", "Points come from correctly recorded visits, so always record each visit with a check-in."),
        ],
    ),
    dict(
        id="settings",
        title="16. Settings",
        img="settings",
        cap="Settings",
        blocks=[
            ("ul", [
                "Phone: your contact number.",
                "Dark mode and Language (Armenian/English).",
                "Power-saving mode: lighter animations for slower phones.",
                "Push notifications: allow them for order status, plans and reminders.",
                "Sync: shows sync status. “Refresh data” and “Refresh product catalogue” load fresh data.",
                "Offline storage: how much data is kept on the phone.",
                "Security: Change password, Manage sessions (sign out other devices).",
                "User guide: this document. “Check for updates” installs a new app version.",
            ]),
        ],
    ),
    dict(
        id="faq",
        title="17. FAQ and troubleshooting",
        blocks=[
            ("table", [
                ["Problem", "What to do"],
                ["The map does not load", "Check your internet and tap “Try again”. On a computer, hard-refresh (Ctrl/Cmd+Shift+R)."],
                ["Location is not verified", "Move closer, wait for the GPS accuracy (±m) to drop, allow location access."],
                ["I cannot see a customer", "Only customers assigned to you are shown. If you think you should see it, ask your sales director."],
                ["Order stays a Draft", "The customer's ERP ID is missing: enter it (or ask the accountant) and submit the order."],
                ["The price looks off", "Price depends on the customer's tier (bronze/silver/gold). The tier is updated from the Excel file, not by hand."],
                ["Debt does not match", "Debt comes from Excel and can lag; check the “data as of” time."],
                ["The app looks old", "Settings → Check for updates."],
                ["No internet", "Keep working: check-ins and orders are stored and sent when the connection returns."],
            ]),
            ("p", "For anything else contact your sales director or the administrator."),
        ],
    ),
    dict(
        id="roles",
        title="18. Who sees what",
        blocks=[
            ("table", [
                ["Role", "Main abilities"],
                ["Sales manager (you)", "Only own customers, visits, orders, payments; own reports: new customers, visits, debt"],
                ["Sales director", "All managers' data, approves orders, reassigns customers, plans routes"],
                ["CEO / Operations director", "Full visibility and approvals"],
                ["Accountant", "Approves payments, product prices, ERP data"],
                ["Warehouse / Delivery", "Packing and delivering orders"],
                ["Administrator", "Users, settings, full access"],
            ]),
        ],
    ),
]
