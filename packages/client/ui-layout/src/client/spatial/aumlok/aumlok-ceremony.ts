// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE AUMLOK CEREMONY IN THE BROWSER.
 *
 * When no desktop shell carries the ceremony, this page runs it against the host's `/_host/aumlok/*` routes
 * (`deploy/cloudflare/src/aumlok.mjs`):
 *
 *   draw    the seven words are drawn HERE from the canonical lists (an anchor, then six words whose first letters
 *           spell it, in the bands Root, Root, Unite, Unite, Rise, Rise) with `crypto.getRandomValues`. They go to the
 *           screen once. What this module keeps is only their commitment and the root sealed under them, never the words.
 *   submit  the words the person typed back are normalised and committed; a match is the proof they hold them. Then
 *           the host's challenges run the platform passkey (Touch ID / Face ID), and the node key the root makes signs
 *           the challenge's intent. A rotation first opens the bound root with the words in use and the bound passkey.
 *
 * CLASS 4: the words never cross the network, never reach the VFS or IndexedDB, and never touch the copy-paste buffer.
 * The node key comes from a 32-byte root sealed by the words (`aumlok-root.ts`, which carries the AUMLOK v2
 * security statement): the root is held only while it is sealed, and the node's signing key is not extractable and is
 * dropped with the pending draw. Only the commitment, the node's public key, the sealed root and the passkey's public
 * proofs cross.
 *
 * WHY THE COMMITMENT IS SLOW AND SALTED. A phrase from these lists carries 43.36 bits (every phrase equally likely).
 * A plain SHA-256 of it, readable by anyone who can read the host's record, falls to a brute-force search in minutes,
 * which would put the phrase in reach of every store that holds the commitment. So `commitmentSha256` is PBKDF2-SHA256
 * (600 000 iterations) salted with the node's public key, and the host keeps it only under its pepper and never serves it.
 *
 * THE LISTS are the owner's canonical AUMLOK lists (from an earlier repository; 92 anchors,
 * ROOT 942, UNITE 1170, RISE 1258). The draw is uniform over all 11 253 636 424 086 valid phrases
 * (2^43.36), not anchor-first: an anchor-first draw would make phrases under the anchors with small buckets likelier,
 * and its min-entropy would be the weakest anchor's 41.5 bits.
 * @module aumlok/aumlok-ceremony
 */
import { hostCall, type HostAnswer } from '../apps/identity/host.ts'
import { base64url, passkeyBlocker, passkeyFailure, readChallenge, runPasskey, type PasskeyChallenge,
  type PasskeyResponseJson } from '../apps/identity/webauthn.ts'
import type { AumlokCeremonyIntent, AumlokCeremonyResult, AumlokDrawnPhrase } from './binding-bridge.ts'
import { AUMLOK_SEAL_ITERATIONS, aumlokNodeOf, newAumlokRoot, openAumlokRoot, parseSealedRoot, sealAumlokRoot, type AumlokNode,
  type AumlokSealedRoot, type ByteFill } from './aumlok-root.ts'

const ANCHOR_WORDS = (
  'acacia arable arcade arctic attach badger ballad ballet bangle banner banter barber barrel barter basalt branch '
  + 'caddie caller camper candid candle canter carpet caster castle catnip cattle chalet chance change cradle crater '
  + 'gadget gaggle gambit gander garage garlic garner garnet gather grader hamlet hammer hamper handle hangar hanger '
  + 'magnet magpie mallet mammal manage manner mantel mantis mantle marble matter paddle palace palate pallet pamper '
  + 'parade parcel pastel phrase prance rabbit ramble ranger rapper rather rattle saddle safari salami sample sandal '
  + 'splash stable stance staple static strait tablet tamale tandem tarmac tassel trader '
).trim()
const ROOT_WORDS = (
  'aardvark abalone acacia acai acorn afterglow afternoon agate agave agriculture air alabaster albatross alder '
  + 'alfalfa alligator almond aloe alpaca alpine amber amethyst amphibian anchovy anemone angora animal anise '
  + 'antelope antler apple apricot aquamarine aquarium aquatic aquifer arable arbor archipelago arctic arid armadillo '
  + 'aromatic artichoke arugula ashore asparagus aspen aster atmosphere atoll aubergine aurora autumn aviary avocado '
  + 'azalea azure baa backcountry badger bale balmy balsa bamboo banana banyan bark barley barnacle barnyard '
  + 'barracuda basalt basil bat bay beach beagle beak beanstalk bear bedrock beehive beetle beetroot beluga berry '
  + 'beryl birch birdhouse birdsong bison blackberry blackbird blossom bluebell blueberry bluebird boar bobcat bonsai '
  + 'botanical boulder bouquet bracken bramble branch breeze broccoli bronco brook buckeye buckwheat bucolic budgie '
  + 'buffalo bulldog bullfrog bumblebee bunny burrow buttercup butterfly butternut buzz cabbage cactus calf camel '
  + 'campfire canary canopy cantaloupe canyon caraway cardamom caribou carnation carp carrot cascade cashew cashmere '
  + 'cassava caterpillar catfish catnip cauliflower cave cedar celery chalk chameleon chamomile chard cheetah cherry '
  + 'chestnut chicken chickpea chicory chili chimpanzee chinchilla chipmunk chirp chrysalis cicada cinnamon citrus '
  + 'clam clay clematis clementine cliff climate cloud clover coast cobalt cockatoo cocoa coconut cocoon cod collie '
  + 'comet compost conch condor conifer continent coo copper coral coriander corn cotton countryside cove cow coyote '
  + 'crab cranberry crane crater crayfish creek crescent cricket crimson crocodile crocus crop crow crystal cub '
  + 'cucumber cumin cumulus cuttlefish cypress daffodil dahlia daisy dale dandelion dawn daylight deciduous deer den '
  + 'desert dew diamond dill dingo dinosaur doe dog dolphin donkey dove downpour downstream dragonfly driftwood '
  + 'drizzle droplet duck dune dusk eagle earth ebb eclipse ecosystem eddy edelweiss eel eggplant eggshell egret '
  + 'elephant elk elm ember emerald emu environment equator equine equinox ermine escarpment estuary eucalyptus '
  + 'evening evergreen ewe falcon farm fauna fawn feather fennel fern ferret field fig finch firefly firewood fish '
  + 'fjord flamingo flax fledgling fleece flint flock flounder flower foal fog foliage foothill forage forest fossil '
  + 'fountain fox fragrant freshwater frog frost fruit furrow gale garden garlic garnet gazelle gecko gem geranium '
  + 'gerbil geyser gibbon ginger ginseng giraffe glacier glade glen glow goat golden goldfinch goldfish goose gopher '
  + 'gorge gorilla gosling gourd grain granite grapefruit grapevine graphite grasshopper grassland gravel greenery '
  + 'greenhouse greyhound grizzly grotto groundhog grouper grouse grove guava gull guppy gust gypsum habitat haddock '
  + 'halibut hamster harbor hardwood hare harvest hawk hawthorn haystack hazelnut hazy headland heather hedgehog '
  + 'hemisphere hen herb herd heron herring hibernation hibiscus hickory highland hillside hilltop hippo hive holly '
  + 'honeybee honeycomb honeydew honeysuckle hoof hoot horizon horse horticulture hound howl huckleberry humid '
  + 'hummingbird humpback husky hyacinth hydrangea ibex ibis iceberg icicle icy igneous iguana impala indigo inland '
  + 'inlet insect invertebrate iridescent iris iron irrigation island isthmus ivy jade jaguar jasmine jasper jay '
  + 'jellyfish jewel jungle juniper jute kale kangaroo kelp kestrel kingfisher kite kitten kiwi knoll koala koi krill '
  + 'ladybug lagoon lake lamb landscape lapis larch lark laurel lava lavender lawn leaf leek legume lemon lemur '
  + 'lentil leopard lettuce lichen lightning lilac lily lime linden linen lion livestock lizard llama loam lobster '
  + 'lotus lowland lumber lush lynx macadamia macaw mackerel magma magnolia magpie mahogany maize malachite mallard '
  + 'mammal mammoth manatee mane mango mangrove mantis maple marble mare marigold marlin marmot marsh meadow meerkat '
  + 'melon meow mesa mesquite mica midday midnight midsummer midwinter millet mineral minnow mint mistletoe misty '
  + 'mockingbird mongoose monkey monsoon moonlight moonrise moonstone moorland moose morel morning moss moth mountain '
  + 'mouse mulberry mulch mule mushroom muskrat mussel mustang mustard myrtle nature nautical nautilus nectar neigh '
  + 'nest newt nightfall nightingale nimbus nocturnal noon nori nugget nutmeg nutshell oak oasis oat obsidian ocean '
  + 'ocelot ochre octopus oink okra olive onion onyx opal opossum orange orangutan orca orchard orchid ore organic '
  + 'oriole osprey ostrich otter outback outcrop outdoor overcast owl oxygen oyster ozone palm panda panorama panther '
  + 'papaya paprika parakeet parkland parrot parsley parsnip partridge pasture paw peach peacock peak peanut pearl '
  + 'peat pebble pecan pelican penguin peninsula peony pepper perch perennial peridot periwinkle permafrost persimmon '
  + 'petal petunia pheasant pigeon piglet pineapple pinto pistachio plankton plant plateau platinum platypus plover '
  + 'plum polar pollen pomegranate pond pony poodle poplar poppy porcupine porpoise possum potato prairie prawn '
  + 'primrose puddle puffin pug puma pumice pumpkin puppy purr pyrite quack quail quartz quill quince quinoa rabbit '
  + 'raccoon radish rainbow raindrop rainfall rainforest raisin ram ranch raspberry raven ravine ray redwood reed '
  + 'reef reindeer reptile resin retriever rhino rhododendron rhubarb rice ridge ripe ripple river roadrunner roar '
  + 'robin rock romaine rooster root rosebud rosemary rosy ruby rural russet rye saffron sage salamander salmon '
  + 'sandalwood sandpiper sandstone sandy sapling sapphire sardine savanna scallop scarlet scenery seabed seagull '
  + 'seahorse seal seashell seaside season seawater seaweed seed sequoia sesame shallot shamrock shark sheaf sheep '
  + 'shellfish shore shrimp shrub silk silt silver sky slate sleet sloth snail snapdragon snapper snowball snowfall '
  + 'snowflake soil solstice songbird sorghum soybean spaniel sparrow spearmint spinach spring sprout spruce squash '
  + 'squid squirrel stag stallion starfish starlight starling stem steppe stingray stone stork storm strait '
  + 'strawberry stream sturgeon succulent sugarcane summer sunbeam sunflower sunrise sunset sunshine surf swan '
  + 'sycamore sylvan tabby tadpole taiga tamarind tangerine taro tarragon tawny teak teal temperate tern terrain '
  + 'terrier thaw thicket thistle thunder thyme tide tiger tilapia timber toad tomato topaz topsoil tortoise toucan '
  + 'tourmaline trail tree tributary trill tropical trout truffle trunk tuber tulip tumbleweed tuna tundra turkey '
  + 'turmeric turnip turquoise turtle twig twilight twinkle umber undergrowth underwater uphill upland upstream '
  + 'upwind urchin valley vanilla vegetable vegetation verdant vernal vine violet vista volcano vole wallaby walleye '
  + 'walnut walrus warbler wasabi watercress waterfall waterfowl watermelon waterway wave weather wetland whale wheat '
  + 'whitefish whitewater wildcat wildebeest wilderness wildflower wildlife willow wind winter wisteria wolf '
  + 'wolverine wombat woodchuck woodland woodpecker woof wool wren yak yam yarrow yearling yew yolk yucca zebra '
  + 'zephyr zinc zircon zucchini '
).trim()
const UNITE_WORDS = (
  'abode academy acceptance acclaim accompany accordion ace acoustic acquaintance acrobat actor admire adopt adore '
  + 'adventure advice affection affinity agree ahoy album alcove allegro ally aloha alphabet alto altruism amiable '
  + 'amphitheater amusement anagram ancestor anecdote animation anniversary announcer anthem anthology apartment '
  + 'appetizer applause applesauce appreciate apprentice apron arcade architect arena aria armchair aroma arrival '
  + 'artist artwork assembly assist athlete attend attentive attic attire audience audiobook audition auditorium aunt '
  + 'author autograph award baby backgammon backyard badminton bagel baker ballad ballet balloon ballpark ballroom '
  + 'band banjo banner banquet banter barbecue barber barista baseball basketball bassoon bazaar beanbag bedtime '
  + 'befriend bell belong benevolent bicycle bingo biography birthday birthplace biscuit bistro blanket boardwalk '
  + 'bond bonfire bongo boogie bookmark bookshelf bookstore bookworm bouquet bowling boyfriend boyhood bracelet bravo '
  + 'bread breakfast bride brisket brother brownie brunch bubble buddy buffet burger burrito butterscotch cabin cafe '
  + 'cake calligraphy calypso camaraderie campfire camping campus candle candy captain caramel card care carnival '
  + 'carousel carpenter carpool cartoon cartwheel casserole caterer celebrate cello centerpiece ceremony champion '
  + 'chaperone charity charm chat cheerful cheerleader cheese chef cherish chess childcare childhood chili chocolate '
  + 'choir chord choreography chorus chowder chronicle chuckle chum cinema circle circus clarinet classmate classroom '
  + 'closeness clown club coach cobbler cocoa coffee coleslaw collaborate college comedian comfort comic commencement '
  + 'community companion compassion compliment composer concert conductor confetti confidant conga congratulate '
  + 'connect considerate contest conversation cookbook cookie cookout cooperate cornbread costume cottage couch '
  + 'counselor couple courtesy courtyard couscous cousin cozy cradle craft crayon crescendo crew cricket croissant '
  + 'croquet crossword crowd cuddle cuisine cupboard cupcake curling curry cushion custard cycling cymbal dad dance '
  + 'darling dashing date daughter daycare dear debut decathlon deck decorate dedication delicious delight dependable '
  + 'designer dessert dialogue diary dice dinner dip director disco discussion dish ditty diving doctor dodgeball '
  + 'doll domino donate doodle doorbell doorstep dorm doting doughnut downtown drama drawing dress drummer drumstick '
  + 'duet dumpling dunk earnest earring easel easygoing eat editor educator egg elder electrician eloquent embrace '
  + 'embroidery emcee empathy enchilada encore encourage endearing engagement enjoy ensemble entertain enthusiasm '
  + 'entree envelope equestrian escapade espresso etching etiquette event exchange excursion exhibition extravaganza '
  + 'extrovert exuberant fable fairground fairness fairytale faithful falafel falsetto family fancy fanfare farewell '
  + 'farmer fashion father favor feast fellowship festival fiance fiction fiddle fiesta film finale firefighter '
  + 'fireplace firework flamenco flatmate florist flute folk fondness fondue food football forgive foster foxtrot '
  + 'freshman friend frolic frontman frosting fudge fundraiser funny gala gallery game gardener garland gather gazebo '
  + 'gelato genealogy generous gentle genuine gesture getaway gift giggle gingerbread girl give glad glee glitter '
  + 'gnocchi goalkeeper golf goodbye goodwill gourmet gracious graduation grandchild grandma grandpa grandson '
  + 'grandstand granola grateful gravy greeting grill grin groove group grownup guacamole guardian guest guide guitar '
  + 'gumbo gym hairdresser halftime hamburger handball handmade handshake handwriting handyman hangout happy '
  + 'harmonica harmony harp haven headliner heartfelt hearth heirloom hello helper heritage hiking hobby hockey '
  + 'holiday homecoming hometown honest honey honor hopscotch horseshoe hospitality host household housemate '
  + 'housewarming howdy huddle hug hula humanity humble hummus humor hurrah husband icebreaker icing illusionist '
  + 'illustrator imagine improv include indie indulge infant infield ingredient inning innkeeper inseparable '
  + 'instructor instrument integrity interact intermission interpreter intramural introduce invite itinerary jamboree '
  + 'jazz jelly jersey jester jewelry jigsaw jingle jive jogging join joke jolly journal joy jubilee juggler juice '
  + 'jukebox junior karaoke kayak kazoo kebab keepsake ketchup kettle kickball kickoff kid kindergarten kindness '
  + 'kinship kiss kitchen kite knit kudos lacrosse lady language lantern lasagna latte laugh layup leader league '
  + 'leapfrog legend leisure lemonade lend lesson letter levity library licorice lifeguard lifelong lighthearted '
  + 'likable limerick linebacker lineup listen literature lively loaf local locket lodge lollipop lore lounge love '
  + 'loyal luau luck ludo luge lullaby lunchbox luncheon lunchtime lute lyric macaroni maestro magazine magician '
  + 'mahjong mailbox mailman mall mambo mandolin marathon mariachi marionette market marmalade marry marshmallow '
  + 'mascot masquerade masterpiece match matinee meal meatball meatloaf mechanic medal medley meet melody member '
  + 'memory mentor menu merchant meringue merry message milkshake mime mingle mirth mistletoe mitten mixtape mocha '
  + 'monologue mosaic mother motto mousse movie mozzarella muffin mural museum music mustard mutual naan nacho '
  + 'namesake nana napkin narrator necklace needlework neighbor nephew netball newborn newcomer newfound newlywed '
  + 'newsletter newspaper newsroom nibble nice nickname niece nifty noble nocturne nod nonprofit noodle nook '
  + 'nostalgia note nougat novel novice nudge nuptial nurse nurture nutcracker nutritionist oatmeal obliging oboe '
  + 'ocarina occasion octave ode offbeat officiate omelet onesie onstage opening opera orator orchestra organizer '
  + 'origami ornament outdoor outfield outfit outgoing outing outreach ovation oven overture paella pageant '
  + 'paintbrush painting pajama pal pancake panini pantomime pantry papa parade parcel parent parfait park partner '
  + 'party pasta pastime pastry patio patron pavilion peacemaker peekaboo people pepperoni percussion perform '
  + 'personable pesto philharmonic phone photograph piano piccolo picnic pie pillow pilot pinball pitcher pizza '
  + 'player playful playground playlist playoff playtime playwright plaza pleasant please plumber poem polite polka '
  + 'polo pool popcorn porch porridge portrait postcard postman potluck pottery praise prelude preschool present '
  + 'pretend pretzel principal prize professor promenade promise proud proverb puck pudding pun puppet puzzle quaint '
  + 'quarterback quartet quest quiche quilt quip quirky quiz quote racing racquet radio raffle rafting ragtime ramen '
  + 'ranger rapport ratatouille ravioli read reassure reception recess recipe recital recognition reconnect recorder '
  + 'recreation referee refrain refreshment regatta reggae rehearsal rejoice rekindle relationship relative relay '
  + 'reliable relish remember remix rendezvous repertoire reply reporter resident resort respect restaurant reunion '
  + 'revel reward rhapsody rhyme rhythm ribbon riddle ride riff ring rink risotto roast rockabilly rodeo romance '
  + 'rookie roommate roster rotisserie rousing rowing rugby rumba rummy runner saga sailor salad salon samba sandbox '
  + 'sandwich sauce savor saxophone scholar schoolboy schoolhouse schoolyard scone scoop scooter scoreboard scout '
  + 'scrapbook scrimmage script scrumptious sculpture seesaw selfie semifinal senior sequin serenade sewing share '
  + 'sherbet shimmy shindig shopkeeper shopping shortbread shortstop showcase showman sibling sidekick sightseeing '
  + 'silly sing sister sitar sitcom skateboard skating sketch skiing skit slapstick sled sleepover slide slumber '
  + 'smile smoothie snack snapshot snooker snowman snuggle soccer social soda sofa softball soiree songbook '
  + 'songwriter sonnet soprano soulmate soup souvenir spaghetti spectator speech splash sport spouse sprinkle '
  + 'sprinter squad stadium stage stamp stepfather stepmother stepson stew sticker stitch stocking storybook '
  + 'storyteller streamer stroll strudel student studio stuffing stylist sugar suitor sundae superhero supper support '
  + 'surfing surprise sushi sweetheart swim swing symphony syrup table tactful tag tailgate tailor takeout talent '
  + 'talk tamale tambourine tandem tango tapestry tapioca tasty teacher teammate teamwork teapot teenager telephone '
  + 'tempo tempura tender tennis tenor tent teriyaki terrace thankful theater thoughtful tiara ticket tickle tinsel '
  + 'tiramisu toast toboggan toddler toffee tofu together topping tortilla touchdown tourist tournament town toy '
  + 'tradition trainer trampoline trapeze treasure treat treble treehouse triathlon tricycle trinket trio trip trivia '
  + 'trombone trophy troubadour troupe truffle trumpet trust truthful tryout tuba tune turntable tutor tutu tuxedo '
  + 'twin twirl ukulele umpire uncle underdog unicycle unison unite unity university unselfish unwind unwrap upbeat '
  + 'upbringing uplift uptown usher vacation valentine vaudeville vendor venue veranda verse vibe village violin '
  + 'virtuoso visit vivacious vocabulary voice volleyball volunteer vow waffle waiter waltz warmth watercolor '
  + 'waterpark wave weaving wedding weekend welcome whimsical whisper whistle wholesome wife wiggle wingman wink '
  + 'winner wish wit woodwork wordplay wow wrap wreath write xylophone yarn yay yearbook yodel yogurt youngster yoyo '
  + 'yummy zany zest zoo '
).trim()
const RISE_WORDS = (
  'abacus abstract abundance academy accelerate accolade accomplish ace achieve acoustic activate acumen adapt '
  + 'advance adventure aerial aerodynamic aerospace aesthetic affirm afterglow agile aim airborne airplane airship '
  + 'algebra algorithm alive alloy almanac aloft altitude amaze ambient ambition amplify amplitude anagram analog '
  + 'anew animation antenna anthology anvil aperture apex apogee apparatus appliance architecture archive ardent '
  + 'arise arithmetic array artifact artist ascend aspire asteroid astonishing astronaut astronomy atlas atmosphere '
  + 'atom attain audacious audio augment aura aurora auspicious authentic author automatic autopilot aviation avid '
  + 'awaken award awesome axiom axis axle azure backbone backup badge balance balloon bandwidth bard barometer '
  + 'battery beacon beaker beam beauty believe benchmark bespoke bestseller beta betterment beyond binary binocular '
  + 'biology bionic biotech biplane blacksmith blimp bliss blockbuster blog blueprint bold bookmark boost bootstrap '
  + 'bounce boundless brainstorm brave breakthrough breathtaking bright brilliant broadband broadcast browser build '
  + 'bulb buoyant button byte cable cadence calculator calibrate calligraphy calm camcorder camera candle canvas '
  + 'carbon carefree carpentry cartography carve catalyst celestial cellphone centrifuge ceramic challenge champion '
  + 'chandelier charger chart chatbot cheerful chemistry chime chip chisel chord cinema cipher circuit clarity clever '
  + 'click climb cloud clue cluster cobalt code cognition collage color colossal comeback comet compass compose '
  + 'computer concept conductor confident connect conscious console contemplate content controller cool copilot core '
  + 'cornerstone cortex cosmos countdown courage craft crater create crescent crest cryptography crystal cube curious '
  + 'current cursor cyan cyberspace cylinder daring dashboard data dauntless dawn daybreak daydream daylight dazzle '
  + 'debut decimal decisive decode dedication deduce deep deft degree delight delve demo density design desktop '
  + 'destiny detector develop device dexterity diagram diameter diamond diary dictionary diffraction digital dignity '
  + 'diligent dimension diode diorama diploma discern discipline discovery disk display doctorate documentary domain '
  + 'dome dongle doodle dovetail download draw dream drive dusk dynamo eager earnest earphone earth easygoing ebook '
  + 'eccentric echelon echo eclectic eclipse ecstatic edit education effervescent efficient effort elastic elation '
  + 'electric electron elegant elevate ellipse eloquent email embark embellish ember emblem embolden embroidery '
  + 'emerge eminent emit emoji emotion empathy empower emulator enable enchanting encode encourage encryption '
  + 'encyclopedia endeavor endless endurance energy engine engrave enhance enigma enjoy enlighten enormous enrich '
  + 'enterprise enthralling enthusiasm envision enzyme eon epic epiphany episode epitome epoch equanimity equation '
  + 'equator equilibrium equinox erudite escalator escapade essay essence esteem etch eternal ethereal ethernet '
  + 'ethical ethos etymology euphoria eureka evening everlasting evolve exact examine excavator exceed excellent '
  + 'excitement excursion exemplary exhibition exhilarating exoplanet exoskeleton expand expedition experiment expert '
  + 'explain explore exponential express exquisite exuberant eyepiece fable fabulous fantastic faraway fascinate '
  + 'fathom fearless feat fervor fiber fiction filament film finesse firework firmware flagship flair flashlight '
  + 'flawless flexible flight float flourish flow fluent fluorescent flux fly focus font forefront foresight forever '
  + 'formula fortitude fortunate forward foundry fractal framework freedom frequency fresh frontier fruitful fuel '
  + 'fulcrum fulfill function fusion future gadget galaxy gallery galore galvanize gateway gauge gaze gear generator '
  + 'genetics genius gentle genuine geometry geothermal giddy gigabyte gizmo glad gleam glee glide glimmer glitter '
  + 'globe glorious glossary glow glyph goal golden goldsmith gorgeous grace gradient graduate grammar grand graphic '
  + 'grasp grateful gravity grit groove growth guidebook gumption gusto gutsy gyroscope habitable haiku halcyon halo '
  + 'hammer handbook handheld handmade hangar happy hardware hardworking harmony harness hashtag hatch headlight '
  + 'headset headway height helicopter helium helix helm hemisphere hero hexagon heyday highlight hilarious history '
  + 'hologram homepage hooray hope horizon horsepower hourglass hover hub humanoid humble humor hunch hybrid '
  + 'hydraulic hydrogen hyperlink hyperspace hypothesis icon idea idyllic ignite illuminate illustration imagine '
  + 'immense impeccable impetus impressive impromptu improve inbox incandescent incomparable incredible indelible '
  + 'independent indigo indomitable industrious infinity information infrared ingenious initiative ink inner innovate '
  + 'input inquisitive insight inspire instinct instrument integrity intelligence interface internet interstellar '
  + 'intrepid intricate intuition invaluable invention invigorate invincible ion iridescent isotope iterate jet '
  + 'jigsaw jolly jot joule journal journey jovial joyful joystick jubilant jumbo jump kaleidoscope keen kernel '
  + 'keyboard keynote keyword kickoff kiln kilowatt kindness kinetic kite knack knowledge kudos laboratory labyrinth '
  + 'ladder lambda lamp landing landmark language lantern laptop laser latent lathe latitude lattice laughter launch '
  + 'laureate layout leap learn lecture legend leisure lens lesson lettering lever levity lexicon library lidar lift '
  + 'lightbulb lighthearted lighthouse lightning lightyear limelight limerick limitless linchpin linear linguistics '
  + 'link liquid literature litmus lively livestream locomotive lofty logarithm logbook logic logo longevity loop '
  + 'lore loudspeaker lucid lucky luminous lunar luster lyric machine maestro magnet magnify majestic maker '
  + 'manuscript map marvelous masterpiece math matrix maze meaning measure mechanical medal meditate mellow melody '
  + 'memory mentor meridian merit merry metaphor meteor microchip microphone microscope microwave mighty milestone '
  + 'mindful mindset mirror mirth mission mobile module molecule momentum monitor moonlight moonwalk morale mosaic '
  + 'motherboard motion motivate motor mural museum music mystery nanosecond narrative nascent nautical navigate neat '
  + 'nebula neon network neural neuroscience neutron new nexus nickel nifty nimble nimbus nitrogen noble node nomad '
  + 'nonfiction nonstop noon nostalgia notebook noteworthy notion nova novel novice nuance nucleus number nylon '
  + 'objective observe octave ode odometer odyssey offbeat ohm onboard oneness online onward open opportunity optical '
  + 'optimism opus orbit origami original oscillator osmosis otherworldly outlook output outshine outstanding '
  + 'overcome overdrive overture oxygen ozone paint palette panorama parachute parallax patent pathfinder patience '
  + 'pattern peace peak pencil pendulum perseverance perspective phenomenon philosophy phone photography photon '
  + 'physics pilot pinnacle pioneer piston pixel planet plasma platform playful plugin podcast poetry poise portal '
  + 'positive potential pottery power precision presence printer prism prize probe processor prodigy profound program '
  + 'progress projector prolific propeller prosper proton prototype pulley pulsar purpose pursuit puzzle quadrant '
  + 'quantum quark quartz quasar query quest quick quiet quill quirky quiz quotient radar radiant radio radius '
  + 'rainbow raise ramp rapid ratio ray reach realize realm reason reboot rebound rebuild receiver receptive recharge '
  + 'record recreation rectangle recursion rediscover refine reflect refraction refresh refuel reinvent rejoice '
  + 'rejuvenate rekindle relativity relax relish remarkable remember remix remote renaissance render rendezvous renew '
  + 'repair repertoire replay replicate repository research resilience resistor resolve resonance resourceful restful '
  + 'restore rethink retro reverie revolve reward rewind rhapsody rhyme rhythm riddle ringtone rise riveting roadmap '
  + 'roam robot robust rocket rosy rotation rousing router rover runtime runway saga satellite savor savvy scanner '
  + 'scholar science screen script sculpture search seek sensor serendipity serenity server shimmer shine shuttle '
  + 'signal silicon simplicity simulation sketch skill skylight skyrocket skyscraper skyward smart smile snapshot '
  + 'soar software solace solar solder solstice solution sonar sonnet soothe soul spaceship spacesuit spacetime '
  + 'spacewalk spark speaker spectacular spectrum sphere spiral spirit splendid spotlight springboard staircase '
  + 'stamina stardust starlight startup steadfast steam stellar stereo stillness storyboard stratosphere streamline '
  + 'strength strive studio stylus sublime success summit sundial sunrise sunshine sunspot superb superhero supernova '
  + 'supersonic surge surpass swift symmetry synapse synthesizer tablet tactile takeoff talent tangent tapestry '
  + 'technology telemetry telephone teleport telescope television template tempo tenacity tensor terrestrial terrific '
  + 'textbook texture thankful theory thermal thermometer thesaurus thesis thinker thought threshold thrill thrive '
  + 'thruster thumbnail tightrope timbre timeless timer tireless titanium toggle token tomorrow toolkit topology '
  + 'torch torque touchscreen tower trailblazer trajectory trampoline tranquil transcend transform transistor '
  + 'translucent trapeze travel trek tremendous triangle trigonometry trilogy tripod triumph trivia trophy trove '
  + 'truth tuner tungsten turbine turntable tutorial tweak twilight twinkle typewriter typography ultraviolet '
  + 'unafraid unbreakable understand unearth unfold unicorn unique universe unlimited unlock unravel unstoppable '
  + 'unveil unwind upbeat update upgrade uplift upload upside upswing upward utopia valiant vantage variable vast '
  + 'vector velocity venture versatile verse vertical vibe vibrant victory video viewfinder vigor vinyl virtual '
  + 'virtue vision vista visualize vital vivacious vivid vocabulary voltage vortex voyage wanderlust watt wavelength '
  + 'waypoint webcam webinar website weightless weld wellbeing wheel whimsical whiteboard widget wifi willpower '
  + 'windmill wing winner wireless wisdom wish wit wonderful wonderland workbench workmanship workshop world wormhole '
  + 'worthy wow wristwatch write xenon xray yacht yardstick yarn yay yearning yellow yes yippee yonder youthful yoyo '
  + 'zany zeal zenith zeppelin zero zest zigzag zillion zip zone zoom '
).trim()

/** The six band slots, in order: words 2-3 Root, 4-5 Unite, 6-7 Rise. */
export const AUMLOK_SLOT_BANDS = ['root', 'root', 'unite', 'unite', 'rise', 'rise'] as const
export type AumlokBand = (typeof AUMLOK_SLOT_BANDS)[number]

const bucketsOf = (words: string): ReadonlyMap<string, readonly string[]> => {
  const buckets = new Map<string, string[]>()
  for (const word of words.split(' ')) {
    const letter = word.slice(0, 1)
    const bucket = buckets.get(letter)
    if (bucket) bucket.push(word); else buckets.set(letter, [word])
  }
  return buckets
}
/** The canonical lists: the anchors, and each band's words bucketed by first letter. */
export const AUMLOK_VOCABULARY = Object.freeze({
  anchors: Object.freeze(ANCHOR_WORDS.split(' ')),
  bands: Object.freeze({ root: bucketsOf(ROOT_WORDS), unite: bucketsOf(UNITE_WORDS), rise: bucketsOf(RISE_WORDS) }),
})

/** Fill bytes from the platform's cryptographic generator (the only source used outside tests). */
export type RandomFill = (array: Uint32Array<ArrayBuffer>) => Uint32Array<ArrayBuffer>
const platformRandom: RandomFill = array => globalThis.crypto.getRandomValues(array)

/**
 * A uniform index in [0, n), rejection-sampled from 32-bit draws so no index is favoured.
 * @param n - the size of the range, 1..2^32.
 * @param random - the generator.
 * @returns the index.
 */
export function uniformIndex(n: number, random: RandomFill = platformRandom): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError('uniformIndex: n out of range')
  const limit = 2 ** 32 - (2 ** 32 % n)
  const draw = new Uint32Array(1)
  for (;;) {
    const value = random(draw)[0] ?? 0
    if (value < limit) return value % n
  }
}

/**
 * A uniform integer in [0, n) for n up to 2^53: 53 bits from two 32-bit draws, rejection-sampled. Every value below
 * 2^53 is an exact double, so no step rounds.
 * @param n - the size of the range, 1..2^53.
 * @param random - the generator.
 * @returns the integer.
 */
export function uniformBelow(n: number, random: RandomFill = platformRandom): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('uniformBelow: n out of range')
  if (n <= 2 ** 32) return uniformIndex(n, random)
  const span = 2 ** 53
  const limit = span - (span % n)
  const draw = new Uint32Array(2)
  for (;;) {
    const [high = 0, low = 0] = random(draw)
    const value = (high >>> 11) * 2 ** 32 + low
    if (value < limit) return value % n
  }
}

/** The six band buckets an anchor opens, slot by slot. */
const bucketsFor = (anchor: string): readonly (readonly string[])[] =>
  AUMLOK_SLOT_BANDS.map((band, slot) => AUMLOK_VOCABULARY.bands[band].get(anchor.charAt(slot)) ?? [])
const ANCHOR_WEIGHTS: readonly number[] = AUMLOK_VOCABULARY.anchors.map(anchor =>
  bucketsFor(anchor).reduce((product, bucket) => product * bucket.length, 1))
/**
 * THE PHRASE SPACE: every valid phrase, counted (the sum over anchors of the product of their six bucket sizes).
 * The draw below is uniform over all of them, so its min-entropy is `bits` (log2 of the count), not the weakest
 * anchor's share. It must stay under 2^53 for the draw to be exact; a list change that breaks that stops here.
 */
export const AUMLOK_PHRASE_SPACE = Object.freeze({
  total: ANCHOR_WEIGHTS.reduce((sum, weight) => sum + weight, 0),
  bits: Math.log2(ANCHOR_WEIGHTS.reduce((sum, weight) => sum + weight, 0)),
  weakestAnchorBits: Math.log2(Math.min(...ANCHOR_WEIGHTS)),
})
if (!Number.isSafeInteger(AUMLOK_PHRASE_SPACE.total) || ANCHOR_WEIGHTS.includes(0)) throw new Error('AUMLOK phrase space is not exact')

/**
 * The phrase at one position of the space: anchors in list order, then the six slot words as mixed-radix digits
 * (slot 1 most significant), each digit an index into its bucket.
 * @param index - 0..total-1.
 * @returns the seven words.
 */
export function aumlokPhraseAt(index: number): readonly string[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= AUMLOK_PHRASE_SPACE.total) throw new RangeError('aumlokPhraseAt: out of range')
  let rest = index
  let anchorIndex = 0
  for (const weight of ANCHOR_WEIGHTS) {
    if (rest < weight) break
    rest -= weight
    anchorIndex += 1
  }
  const anchor = AUMLOK_VOCABULARY.anchors[anchorIndex] ?? ''
  const buckets = bucketsFor(anchor)
  const digits: number[] = []
  for (let slot = buckets.length - 1; slot >= 0; slot -= 1) {
    const size = buckets[slot]?.length ?? 1
    digits[slot] = rest % size
    rest = Math.floor(rest / size)
  }
  return [anchor, ...buckets.map((bucket, slot) => bucket[digits[slot] ?? 0] ?? '')]
}

/**
 * The position of a phrase in the space (the inverse of `aumlokPhraseAt`).
 * @param words - seven canonical words.
 * @returns the index, or null when the words are not a phrase.
 */
export function aumlokPhraseIndex(words: readonly string[]): number | null {
  const parsed = parseAumlokPhrase(words)
  if (!parsed.ok) return null
  const [anchor = '', ...rest] = parsed.words
  const anchorIndex = AUMLOK_VOCABULARY.anchors.indexOf(anchor)
  let index = 0
  for (const [slot, bucket] of bucketsFor(anchor).entries()) index = index * bucket.length + bucket.indexOf(rest[slot] ?? '')
  return ANCHOR_WEIGHTS.slice(0, anchorIndex).reduce((sum, weight) => sum + weight, 0) + index
}

/**
 * Draw one phrase, uniformly over every valid phrase (each anchor weighted by the phrases it opens), so no anchor's
 * smaller buckets make any phrase likelier than another.
 * @param random - the generator (the platform's, outside tests).
 * @returns the seven words: an anchor, then for each of its six letters a word from that slot's band.
 */
export function generateAumlokPhrase(random: RandomFill = platformRandom): readonly string[] {
  return aumlokPhraseAt(uniformBelow(AUMLOK_PHRASE_SPACE.total, random))
}

export type AumlokPhraseParse =
  | { readonly ok: true; readonly words: readonly string[]; readonly canonical: string }
  | { readonly ok: false; readonly code: 'phrase-length' | 'phrase-anchor' | 'phrase-word' | 'phrase-acrostic' }
/**
 * Normalise and check a phrase as the crate does: NFKC, lower case, split on whitespace, exactly seven words, an anchor
 * from the list, each word in its band, and each word starting with the anchor's letter at its slot.
 * @param input - the phrase as typed (one string) or as seven entries.
 * @returns the canonical form (`words.join(' ')`), or why it is not a phrase.
 */
export function parseAumlokPhrase(input: string | readonly string[]): AumlokPhraseParse {
  const joined = typeof input === 'string' ? input : input.join(' ')
  if (joined.length > 1024) return { ok: false, code: 'phrase-length' }
  const words = joined.normalize('NFKC').toLowerCase().split(/\s+/u).filter(word => word !== '')
  if (words.length !== 7) return { ok: false, code: 'phrase-length' }
  const [anchor = '', ...rest] = words
  if (!AUMLOK_VOCABULARY.anchors.includes(anchor)) return { ok: false, code: 'phrase-anchor' }
  for (const [slot, word] of rest.entries()) {
    const band = AUMLOK_SLOT_BANDS[slot] ?? 'rise'
    if (word.charAt(0) !== anchor.charAt(slot)) return { ok: false, code: 'phrase-acrostic' }
    if (!(AUMLOK_VOCABULARY.bands[band].get(word.charAt(0)) ?? []).includes(word)) return { ok: false, code: 'phrase-word' }
  }
  return { ok: true, words, canonical: words.join(' ') }
}

/**
 * THE COMMITMENT, salted per node. The host stores only `commitmentSha256` (no salt field crosses), so the salt is the
 * node's public key, which the host keeps and serves: PBKDF2-SHA256 over `aukora.aumlok.v1\0` + the normalised words,
 * salt `aukora.aumlok.v1\0` + nodePubkeyHex, 600 000 iterations, 32 bytes. Every guess at a phrase costs that work.
 */
export const AUMLOK_COMMITMENT_DOMAIN = 'aukora.aumlok.v1\0'
export const AUMLOK_KDF_ITERATIONS = 600_000
export const AUMLOK_COMMITMENT_SCHEME = 'aukora.aumlok.v1/pbkdf2-sha256/600000/salt=node-pubkey'
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * The commitment to a canonical phrase for one node.
 * @param canonical - the canonical phrase (`parseAumlokPhrase(...).canonical`).
 * @param nodePubkeyHex - the node's public key (the salt).
 * @param iterations - the work factor (tests lower it; production uses the default).
 * @returns 64 lower-case hex characters.
 */
export async function aumlokCommitment(
  canonical: string, nodePubkeyHex: string, iterations: number = AUMLOK_KDF_ITERATIONS,
): Promise<string> {
  const encoder = new TextEncoder()
  const material = await globalThis.crypto.subtle.importKey('raw', encoder.encode(AUMLOK_COMMITMENT_DOMAIN + canonical), 'PBKDF2', false, ['deriveBits'])
  const salt = encoder.encode(AUMLOK_COMMITMENT_DOMAIN + nodePubkeyHex)
  return hex(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256))
}

/** Same-origin routes the host serves (`deploy/cloudflare/src/aumlok.mjs`); a host without them reads as absent. */
export const AUMLOK_ROUTES = Object.freeze({
  status: '/_host/aumlok/status',
  challenge: '/_host/aumlok/challenge',
  bind: '/_host/aumlok/bind',
  refresh: '/_host/aumlok/refresh',
  unseal: '/_host/aumlok/unseal',
  approve: '/_host/aumlok/approve',
  /** The last step of an invite or a revocation (aukora.invite.v1; `apps/identity/invite.ts`). */
  invite: '/_host/aumlok/invite',
})
/** What the node signs to prove it holds the key it names (the host's `AUMLOK_NODE_DOMAIN` + the challenge's intent). */
export const AUMLOK_NODE_DOMAIN = 'aukora.aumlok.node-possession.v1\n'

/** The node's binding as the host reports it (`aukora.aumlok.status.v1`). Nothing absent is filled in. */
export interface AumlokHostStatus {
  readonly state: 'unbound' | 'bound'
  readonly passkeyVerified: boolean
  readonly nodePubkeyHex: string | null
  readonly commitmentSha256: string | null
  /** Milliseconds since the epoch, as the host records it. */
  readonly boundAt: number | null
  readonly enrollmentAvailable: boolean
  readonly blockers: readonly string[]
  readonly identityIsKey: boolean
  readonly domainIsPointer: boolean
  readonly invites: { readonly issued: number; readonly limit: number; readonly month: string } | null
  /**
   * Round 23 (Lanes 2-3): a non-reversible handle of the active sealed-root revision, and its sequence. A rotation that
   * committed changes them, so a lost answer can be settled from the status. Null on a host that does not send them.
   */
  readonly keyCommitmentId: string | null
  readonly rotationSeq: number | null
  /** Round 23: the passkey approvals the host still holds for this binding (public records, not authority). */
  readonly approvedGrants: readonly AumlokApprovalRecord[]
  /**
   * Round 24 (Lanes 2-3): the challenge id of the last rotation the host committed. A page that sent that challenge's
   * last step knows the rotation in force is its own. Null on a host that does not send it.
   */
  readonly lastRotationChallengeId: string | null
  /**
   * Round 24 (Lanes 2-3): the host's own word on whether its pepper is mixed with a secret kept outside the store that
   * holds the sealed root (so a copy of that store alone cannot test guesses offline). Null when the host does not say.
   */
  readonly pepperSeparated: boolean | null
  /**
   * Round 25: whether this host checks the words' commitment online at `unseal`. A Round 24 host (Lanes 2-3) says
   * `pepperSeparated` on every status and reads `commitmentSha256` there; an older host refuses unknown fields.
   */
  readonly checksPhraseOnline: boolean
}
/** One durable approval the host lists (`aumlok.approval.v1`): what it binds, and its times. */
export interface AumlokApprovalRecord {
  readonly approvalId: string
  readonly binding: Readonly<Record<string, unknown>>
  readonly approvedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | null
}
export type AumlokHostRead =
  | { readonly kind: 'reading' }
  | { readonly kind: 'live'; readonly status: AumlokHostStatus }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unreadable' }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, pattern: RegExp): string | null => (typeof value === 'string' && pattern.test(value) ? value : null)
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)
/** A host blocker is any named code, not only an AUMLOK_ one: the edge also says NODE_KEY_IS_NOT_OWNER_KEY (Round 27). */
const BLOCKER_CODE = /^[A-Z][A-Z0-9_]{1,80}$/u

/**
 * Read the host's status. Its `phase` must be BOUND or UNBOUND and agree with `bound`; a bound node must name its key.
 * Anything else is unreadable rather than guessed.
 * @param body - the host's JSON answer.
 * @returns the status, or null when it is not that shape.
 */
export function parseAumlokStatus(body: Record<string, unknown>): AumlokHostStatus | null {
  const phase = typeof body.phase === 'string' ? body.phase : ''
  if ((phase !== 'BOUND' && phase !== 'UNBOUND') || body.bound !== (phase === 'BOUND')) return null
  const bound = phase === 'BOUND'
  const nodePubkeyHex = text(body.nodePubkeyHex, /^[0-9a-f]{64}$/u)
  const commitmentSha256 = text(body.commitmentSha256, /^[0-9a-f]{64}$/u)
  // A bound node must name its key. The commitment is no longer served (AUMLOK v2 keeps it peppered at the host, so it
  // cannot check a guess offline); one a host still serves is read, and none is ever required.
  if (bound && nodePubkeyHex === null) return null
  const invite = isRecord(body.invite) ? body.invite : null
  const issued = invite === null ? null : count(invite.issuedThisMonth)
  const limit = invite === null ? null : count(invite.limit)
  const month = invite === null ? null : text(invite.quotaMonth, /^\d{4}-\d{2}$/u)
  return {
    state: bound ? 'bound' : 'unbound',
    passkeyVerified: body.passkeyVerified === true,
    nodePubkeyHex,
    commitmentSha256,
    boundAt: count(body.boundAt) !== null && Number(body.boundAt) <= 8_640_000_000_000_000 ? count(body.boundAt) : null,
    enrollmentAvailable: body.enrollmentAvailable === true,
    blockers: Array.isArray(body.blockers) ? body.blockers.filter((code): code is string => typeof code === 'string' && BLOCKER_CODE.test(code)) : [],
    identityIsKey: body.identityIsKey === true,
    domainIsPointer: body.domainIsPointer === true,
    invites: issued === null || limit === null || month === null ? null : { issued, limit, month },
    keyCommitmentId: text(body.keyCommitmentId, /^[A-Za-z0-9_-]{8,128}$/u),
    rotationSeq: count(body.rotationSeq),
    lastRotationChallengeId: text(body.lastRotationChallengeId, /^[A-Za-z0-9_-]{8,128}$/u),
    pepperSeparated: typeof body.pepperSeparated === 'boolean' ? body.pepperSeparated : null,
    checksPhraseOnline: typeof body.pepperSeparated === 'boolean' || body.phraseCheckOnline === true,
    approvedGrants: Array.isArray(body.approvedGrants) ? body.approvedGrants.flatMap((value: unknown): AumlokApprovalRecord[] => {
      if (!isRecord(value) || value.schema !== 'aumlok.approval.v1' || !isRecord(value.binding)) return []
      const approvalId = text(value.approvalId, /^[A-Za-z0-9_-]{8,128}$/u)
      const approvedAt = count(value.approvedAt)
      const expiresAt = count(value.expiresAt)
      if (approvalId === null || approvedAt === null || expiresAt === null) return []
      return [{ approvalId, binding: value.binding, approvedAt, expiresAt, consumedAt: count(value.consumedAt) }]
    }).slice(0, 16) : [],
  }
}

/** One host call: the same classification the owner card uses (a 404/405/501 or non-JSON answer is absent). */
export type AumlokHostCall = (route: string, signal: AbortSignal, body?: Record<string, unknown>) => Promise<HostAnswer>

/**
 * Read the node's binding from its own host.
 * @param signal - aborts the read.
 * @param call - the host call (tests pass a fake).
 * @returns the classified status.
 */
export async function readAumlokStatus(signal: AbortSignal, call: AumlokHostCall = hostCall): Promise<AumlokHostRead> {
  const answer = await call(AUMLOK_ROUTES.status, signal)
  if (answer.kind === 'absent') return { kind: 'absent', detail: answer.detail }
  if (answer.kind === 'refused') return { kind: 'refused', code: answer.code }
  const status = parseAumlokStatus(answer.body)
  return status === null ? { kind: 'unreadable' } : { kind: 'live', status }
}

/** The platform pieces a ceremony needs, so tests can stand in for the browser. */
export interface AumlokPlatform {
  /** Why no passkey ceremony can run in this page, or null. */
  readonly passkeyBlocker: () => string | null
  /** The browser's passkey sheet (Touch ID / Face ID) on the host's challenge. */
  readonly passkey: (step: PasskeyChallenge, signal: AbortSignal) => Promise<PasskeyResponseJson>
  /** Whether this browser can make and use an Ed25519 node key. */
  readonly nodeKeys: () => Promise<boolean>
}
export const browserPlatform: AumlokPlatform = {
  passkeyBlocker,
  passkey: runPasskey,
  async nodeKeys() {
    // The exact path a binding takes: an Ed25519 key imported from a root-derived seed (an all-zero test root here).
    try {
      await aumlokNodeOf(new Uint8Array(32))
      return true
    } catch { return false }
  },
}

/**
 * Whether a ceremony can run here now, and if not, why (the owner sees the reason, not a dead control).
 * @param status - the host's status.
 * @param platform - the browser's capabilities.
 * @returns ok, or the reason.
 */
export async function aumlokCeremonyAvailability(status: AumlokHostStatus, platform: AumlokPlatform = browserPlatform)
  : Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (status.state === 'unbound' && !status.enrollmentAvailable) {
    return { ok: false, reason: `this host has no trusted owner approval for a first binding yet (${status.blockers.join(', ') || 'enrollment unavailable'})` }
  }
  if (status.state === 'bound' && !status.passkeyVerified) return { ok: false, reason: 'the binding has no verified passkey to confirm a rotation' }
  // A bound host that refuses every ceremony (a lock) offers none here, rather than a control that always fails.
  if (status.state === 'bound' && status.blockers.length > 0) return { ok: false, reason: `this host refuses ceremonies now (${status.blockers.join(', ')})` }
  const blocker = platform.passkeyBlocker()
  if (blocker !== null) return { ok: false, reason: `${blocker}; binding here needs a passkey` }
  // Binding and rotation both need the node's Ed25519 key in this browser: checked before any passkey is asked for.
  if (!await platform.nodeKeys()) return { ok: false, reason: 'this browser cannot make an Ed25519 node key' }
  return { ok: true }
}

export interface BrowserCeremonyOptions {
  readonly call?: AumlokHostCall
  readonly random?: RandomFill
  /** The byte generator for the root, salt and IV (the platform's, outside tests). */
  readonly bytes?: ByteFill
  readonly platform?: AumlokPlatform
  /** The commitment's work factor (tests lower it; production keeps the default). */
  readonly iterations?: number
  /** The seal's work factor, and the lowest a sealed root from the host is accepted at (the host's floor is 600 000). */
  readonly sealIterations?: number
}
export interface BrowserCeremony {
  /**
   * Draw new words. A rotation first opens the bound root: `current` is the phrase in use now, the bound passkey
   * releases the sealed root, and the words open it (they are not kept).
   */
  draw: (intent: AumlokCeremonyIntent, status: AumlokHostStatus | null, current?: readonly string[]) => Promise<AumlokDrawnPhrase>
  submit: (intent: AumlokCeremonyIntent, typed: readonly string[]) => Promise<AumlokCeremonyResult>
  /** Forget the pending draw and abort anything in flight (the screen closed), except a last step already sent. */
  reset: () => void
  /**
   * The result of a last step that finished after the screen closed (its POST is never aborted), once; null otherwise.
   */
  takeSettled: () => { readonly intent: AumlokCeremonyIntent; readonly result: AumlokCeremonyResult } | null
  /** Be told when such a last step settles (the screen may be open again by then). Returns the unsubscribe. */
  onSettled: (listener: () => void) => () => void
}
/** The sealed-root revision a ceremony starts from (Round 23 status fields). */
interface KeyRevision { readonly keyCommitmentId: string | null; readonly rotationSeq: number | null }
/** The host's answer to the last step was lost, and its status shows the step committed (see `finish`). */
export const AUMLOK_SETTLED_BY_STATUS = 'aumlok:settled-by-status'
/**
 * The host's answer to a rotation's last step was lost, and its status names THIS ceremony's challenge as the last
 * rotation it committed (`lastRotationChallengeId`): the new words typed here are the ones in force.
 */
export const AUMLOK_SETTLED_AS_THIS_CEREMONY = 'aumlok:settled-as-this-ceremony'
/** The host did not answer a ceremony's last step, even when asked again: which words are in force is not known here. */
export const AUMLOK_OUTCOME_UNKNOWN = 'aumlok:outcome-unknown'
const refusal = (code: string, drawSpent = false): AumlokCeremonyResult =>
  (drawSpent ? { ok: false, reason: code.slice(0, 128), drawSpent: true } : { ok: false, reason: code.slice(0, 128) })
/** A credential in the exact shape the host's validator accepts (no null attachment, no extension results). */
export const forHost = (credential: PasskeyResponseJson): Record<string, unknown> => ({
  id: credential.id, rawId: credential.rawId, type: credential.type, response: credential.response, clientExtensionResults: {},
  ...(credential.authenticatorAttachment === 'platform' || credential.authenticatorAttachment === 'cross-platform'
    ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
})
export const aumlokRequestId = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return base64url(bytes)
}
/**
 * A refusal keeps the host's code. A lost answer (`hostCall` could not fetch, so the request may have reached the host and
 * a wrong phrase may be counted there) is 'not-answered'; 'route-absent' stays for a real 404/405/501 or non-JSON answer.
 */
const answerCode = (answer: HostAnswer): string => (answer.kind === 'refused' ? `aumlok:${answer.code}`
  : answer.kind === 'absent' && answer.detail.startsWith('the host did not answer') ? 'aumlok:not-answered' : 'aumlok:route-absent')

export interface UnsealDependencies {
  readonly call: AumlokHostCall
  readonly platform: AumlokPlatform
  readonly signal: AbortSignal
  /** The lowest work factor a sealed root is accepted at (production: 600 000). */
  readonly minIterations?: number
  /** The work factor of the words' commitment (production: 600 000; tests pass less). */
  readonly commitmentIterations?: number
}
export type AumlokUnsealed =
  | { readonly ok: true; readonly root: Uint8Array<ArrayBuffer>; readonly node: AumlokNode }
  | { readonly ok: false; readonly reason: string }

/**
 * OPEN THE BOUND ROOT: the words in use now, checked here first; the bound passkey asserts the host's `unseal`
 * challenge; the host hands back the sealed root from its escrow; the words open it, and it must make the bound node.
 * This is what a rotation and an invite signature start from. Nothing here keeps the words; the caller zeroes the root.
 * @param current - the phrase in use now.
 * @param status - the host's status (bound, with its node key).
 * @param deps - the host call, the passkey, and the abort signal.
 * @returns the root and its node, or why not.
 */
export async function unsealAumlokNode(current: readonly string[], status: AumlokHostStatus, deps: UnsealDependencies)
  : Promise<AumlokUnsealed> {
  const parsed = parseAumlokPhrase(current)
  if (!parsed.ok) return { ok: false, reason: 'aumlok:current-words-invalid' }
  if (status.state !== 'bound' || status.nodePubkeyHex === null) return { ok: false, reason: 'aumlok:not-bound' }
  // THE HOST CHECKS THE WORDS ONLINE where it can (Round 24, Lanes 2-3, F3a): their commitment, salted with the bound node
  // key, rides the last step, and a host that checks it says so in its status. An older host takes no such field (it
  // refuses unknown fields), so the commitment goes only where it is read. Either way the words must still open the root.
  const commitmentSha256 = status.checksPhraseOnline
    ? await aumlokCommitment(parsed.canonical, status.nodePubkeyHex, deps.commitmentIterations ?? AUMLOK_KDF_ITERATIONS) : null
  return unsealAumlokNodeWith(parsed.canonical, commitmentSha256, status, deps)
}

/**
 * THE SAME OPENING, FROM A COMMITMENT WORKED OUT BEFORE THE TAP. Safari opens a passkey sheet only inside the tap that
 * asked for it, so a page that can (the invite panel, `apps/identity/invite.ts`) computes the 600 000-iteration
 * commitment while the person is still typing, and the tap itself asks only for the challenge. `unsealAumlokNode` is
 * exactly this, with the commitment computed first.
 * @param canonical - the canonical phrase in use now (`parseAumlokPhrase(...).canonical`); it opens the root here.
 * @param commitmentSha256 - its commitment for this node, or null for a host that does not check the words online.
 * @param status - the host's status (bound, with its node key).
 * @param deps - the host call, the passkey, and the abort signal.
 * @param requestId - the challenge's request id. A second tap after a passkey that did not complete asks with the same
 *   one, and the host answers the same open challenge.
 * @returns the root and its node, or why not. The caller zeroes the root.
 */
export async function unsealAumlokNodeWith(canonical: string, commitmentSha256: string | null, status: AumlokHostStatus,
  deps: UnsealDependencies, requestId: string = aumlokRequestId()): Promise<AumlokUnsealed> {
  if (status.state !== 'bound' || status.nodePubkeyHex === null) return { ok: false, reason: 'aumlok:not-bound' }
  const challenge = await deps.call(AUMLOK_ROUTES.challenge, deps.signal, { purpose: 'unseal', requestId })
  if (challenge.kind !== 'live') return { ok: false, reason: answerCode(challenge) }
  const assert = readChallenge('verify', challenge.body)
  const asserted = await deps.platform.passkey(assert, deps.signal)
  const done = await deps.call(AUMLOK_ROUTES.unseal, deps.signal, commitmentSha256 === null
    ? { challengeId: assert.ceremonyId, credential: forHost(asserted) }
    : { challengeId: assert.ceremonyId, credential: forHost(asserted), commitmentSha256 })
  if (done.kind !== 'live') return { ok: false, reason: answerCode(done) }
  const sealed = parseSealedRoot(done.body.sealedRoot, deps.minIterations)
  if (sealed === null) return { ok: false, reason: 'aumlok:sealed-root-invalid' }
  const opened = await openAumlokRoot(sealed, canonical, status.nodePubkeyHex)
  return opened.ok ? { ok: true, root: opened.root, node: opened.node } : { ok: false, reason: opened.code }
}

/**
 * A ceremony that runs in this page against the host's `/_host/aumlok/*` routes (Lanes 2-3).
 *
 *   bind     draw: a fresh 32-byte root, the node it makes (aumlok-root.ts), the words, their commitment salted with the
 *            node key, and the root sealed under the words; the root is zeroed once sealed. submit: the typed words must
 *            commit to the same value; then challenge {purpose, requestId, commitmentSha256, nodePubkeyHex, sealed
 *            root}, the passkey is registered, the host answers a second challenge, the passkey asserts it and the node
 *            key signs AUMLOK_NODE_DOMAIN + its intentHash.
 *   refresh  draw: the bound root is opened (unsealAumlokNode: current words + bound passkey), new words are drawn and
 *            the SAME root is sealed under them, so the node keeps its key. submit: challenge {purpose, requestId,
 *            commitmentSha256, sealed root}, the bound passkey asserts it and the node key signs its intent.
 *   The node's signing key never leaves WebCrypto; it is dropped with the pending draw either way.
 * @param options - test seams; production passes none.
 * @returns the draw and submit verbs the AUMLOK screen calls.
 */
export function createBrowserCeremony(options: BrowserCeremonyOptions = {}): BrowserCeremony {
  const call = options.call ?? hostCall
  const random = options.random ?? platformRandom
  const bytes = options.bytes
  const platform = options.platform ?? browserPlatform
  const iterations = options.iterations ?? AUMLOK_KDF_ITERATIONS
  const sealIterations = options.sealIterations ?? AUMLOK_SEAL_ITERATIONS
  let pending: {
    readonly intent: AumlokCeremonyIntent
    readonly commitment: string
    readonly nodePubkeyHex: string
    readonly nodeKey: CryptoKey
    readonly sealed: AumlokSealedRoot
    /** The revision this ceremony starts from, to settle a lost last answer from the status. */
    readonly before: KeyRevision
  } | null = null
  let controller = new AbortController()
  let token = 0
  let settled: { readonly intent: AumlokCeremonyIntent; readonly result: AumlokCeremonyResult } | null = null
  const listeners = new Set<() => void>()

  const draw = async (
    intent: AumlokCeremonyIntent, status: AumlokHostStatus | null, current?: readonly string[],
  ): Promise<AumlokDrawnPhrase> => {
    const mine = ++token
    const signal = controller.signal
    pending = null
    // A new ceremony supersedes the report of an older one that settled after a close.
    settled = null
    if (status === null) return { ok: false, reason: 'aumlok:status-unread' }
    if (intent === 'refresh' && (status.state !== 'bound' || status.nodePubkeyHex === null)) return { ok: false, reason: 'aumlok:not-bound' }
    if (intent === 'bind' && status.state !== 'unbound') return { ok: false, reason: 'aumlok:already-bound' }
    let root: Uint8Array<ArrayBuffer>
    let opened: AumlokUnsealed | null = null
    if (intent === 'refresh') {
      if (current === undefined) return { ok: false, reason: 'aumlok:current-words-needed' }
      try {
        opened = await unsealAumlokNode(current, status,
          { call, platform, signal, minIterations: sealIterations, commitmentIterations: iterations })
      } catch (error) {
        return { ok: false, reason: signal.aborted ? 'aumlok:closed' : `aumlok:passkey ${passkeyFailure(error)}` }
      }
      if (!opened.ok) return { ok: false, reason: opened.reason }
      root = opened.root
    } else {
      root = newAumlokRoot(bytes)
    }
    let node: AumlokNode
    let commitment: string
    let sealed: AumlokSealedRoot
    let words: readonly string[]
    try {
      node = opened?.ok === true ? opened.node : await aumlokNodeOf(root)
      words = generateAumlokPhrase(random)
      const parsed = parseAumlokPhrase(words)
      if (!parsed.ok) return { ok: false, reason: 'aumlok:draw-failed' }
      commitment = await aumlokCommitment(parsed.canonical, node.nodePubkeyHex, iterations)
      sealed = await sealAumlokRoot(root, parsed.canonical, node.nodePubkeyHex,
        { iterations: sealIterations, ...(bytes === undefined ? {} : { random: bytes }) })
    } finally {
      // THE ROOT IS HELD ONLY WHILE IT IS SEALED: from here on only its sealed form and the node's signing key remain.
      root.fill(0)
    }
    // A newer draw, or a reset, superseded this one while it worked: it must not become the pending ceremony.
    if (mine !== token) return { ok: false, reason: 'aumlok:draw-superseded' }
    pending = { intent, commitment, nodePubkeyHex: node.nodePubkeyHex, nodeKey: node.signingKey, sealed,
      before: { keyCommitmentId: status.keyCommitmentId, rotationSeq: status.rotationSeq } }
    return { ok: true, words }
  }

  const submit = async (intent: AumlokCeremonyIntent, typed: readonly string[]): Promise<AumlokCeremonyResult> => {
    const signal = controller.signal
    const held = pending
    if (held?.intent !== intent) return refusal('aumlok:no-draw', true)
    const stale = (): boolean => signal.aborted || pending !== held
    // THE TYPED WORDS ARE COMMITTED AND DROPPED: only the commitment is compared, and nothing here keeps them.
    const parsed = parseAumlokPhrase(typed)
    if (!parsed.ok || await aumlokCommitment(parsed.canonical, held.nodePubkeyHex, iterations) !== held.commitment) {
      return stale() ? refusal('aumlok:closed', true) : refusal('aumlok:words-differ')
    }
    if (stale()) return refusal('aumlok:closed', true)
    // From here every failure spends the draw (a passkey may already exist for it, so a retry starts over cleanly), and
    // every exit drops the pending ceremony with its node key.
    // THE REVISION THIS ROTATION STARTS FROM is read fresh, right before its challenge (the screen's status may be old,
    // and a rotation from another device would otherwise look like this one).
    // If that read fails, nothing can settle this rotation from the status later (it stays unknown when its answer is lost).
    let before = held.before
    if (intent === 'refresh') {
      const fresh = await readAumlokStatus(signal, call).catch(() => null)
      before = fresh?.kind === 'live' ? { keyCommitmentId: fresh.status.keyCommitmentId, rotationSeq: fresh.status.rotationSeq }
        : { keyCommitmentId: null, rotationSeq: null }
    }
    try {
      const challenge = await call(AUMLOK_ROUTES.challenge, signal, intent === 'bind'
        ? { purpose: 'bind', requestId: aumlokRequestId(), commitmentSha256: held.commitment, nodePubkeyHex: held.nodePubkeyHex, ...held.sealed }
        : { purpose: 'refresh', requestId: aumlokRequestId(), commitmentSha256: held.commitment, ...held.sealed })
      if (stale()) return refusal('aumlok:closed', true)
      if (challenge.kind !== 'live') return refusal(answerCode(challenge), true)
      let answer: HostAnswer = challenge
      if (intent === 'bind') {
        const register = readChallenge('register', answer.body)
        const created = await platform.passkey(register, signal)
        if (stale()) return refusal('aumlok:closed', true)
        answer = await call(AUMLOK_ROUTES.bind, signal, { challengeId: register.ceremonyId, credential: forHost(created) })
        if (stale()) return refusal('aumlok:closed', true)
        if (answer.kind !== 'live') return refusal(answerCode(answer), true)
        if (answer.body.phase !== 'PENDING_ASSERTION') return refusal('aumlok:unexpected-answer', true)
      }
      const assert = readChallenge('verify', answer.body)
      const intentHash = text(answer.body.intentHash, /^[0-9a-f]{64}$/u)
      // THE NODE SIGNS ONLY ITS OWN DOMAIN PREFIX AND A 32-BYTE INTENT, checked before the passkey prompt so a malformed
      // answer never asks the person for anything. (The intent itself is the host's: it binds the host's challenge
      // record, and the page cannot recompute it.)
      if (intentHash === null || answer.body.nodeProofPreimage !== AUMLOK_NODE_DOMAIN + intentHash) return refusal('aumlok:intent-mismatch', true)
      const asserted = await platform.passkey(assert, signal)
      if (stale()) return refusal('aumlok:closed', true)
      const nodeSignature = base64url(new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', held.nodeKey,
        new TextEncoder().encode(AUMLOK_NODE_DOMAIN + intentHash))))
      // THE LAST STEP CANNOT BE TAKEN BACK: once it is sent the host may commit it (a rotation then seals the root under
      // the new words only). So closing the screen does not abort it, and a lost answer is asked again once with the
      // SAME body, which the host answers idempotently (a committed step reads BOUND, a refused one CHALLENGE_USED).
      const result = await finish(intent, { challengeId: assert.ceremonyId, credential: forHost(asserted), nodeSignature },
        { nodePubkeyHex: held.nodePubkeyHex, before, challengeId: assert.ceremonyId })
      if (stale()) {
        settled = { intent, result }
        for (const listener of listeners) listener()
        return refusal('aumlok:closed', true)
      }
      return result
    } catch (error) {
      return refusal(stale() ? 'aumlok:closed' : `aumlok:passkey ${passkeyFailure(error)}`, true)
    } finally {
      // The node key is dropped with the pending ceremony either way.
      if (pending === held) pending = null
    }
  }

  /**
   * Send the last step on a signal no reset aborts. Only two answers are definite: BOUND, and the AUMLOK store's own
   * 4xx refusal (it commits nothing on a refusal). Anything else (no answer, a cut or non-JSON body, a 5xx such as the
   * edge's CLOUD_REQUEST_FAILED when its Durable Object call broke after a commit) may hide a commit, so it is asked
   * once more with the SAME body, which the host answers idempotently; still unclear, it is "unknown".
   */
  const finish = async (intent: AumlokCeremonyIntent, body: Record<string, unknown>,
    held: { readonly nodePubkeyHex: string; readonly before: KeyRevision; readonly challengeId: string | null },
  ): Promise<AumlokCeremonyResult> => {
    const route = intent === 'bind' ? AUMLOK_ROUTES.bind : AUMLOK_ROUTES.refresh
    const lasting = new AbortController().signal
    const committed = (answer: HostAnswer): boolean => answer.kind === 'live' && answer.body.phase === 'BOUND'
    const refusedHere = (answer: HostAnswer): answer is Extract<HostAnswer, { kind: 'refused' }> =>
      answer.kind === 'refused' && /^AUMLOK_/u.test(answer.code) && answer.status >= 400 && answer.status < 500
    const first = await call(route, lasting, body)
    if (committed(first)) return { ok: true }
    if (refusedHere(first)) return refusal(answerCode(first), true)
    const again = await call(route, lasting, body)
    if (committed(again)) return { ok: true }
    // CHALLENGE_USED on a replay: the first attempt reached the host and was refused (a commit would replay as BOUND).
    // CHALLENGE_EXPIRED on a replay says nothing about the first attempt.
    if (refusedHere(again) && again.code !== 'AUMLOK_CHALLENGE_EXPIRED') return refusal(answerCode(again), true)
    // STILL UNCLEAR: the host's status can settle a commit, and only a commit. A binding committed when this node, whose
    // key was made in this page, is bound.
    // A ROTATION, ON A HOST THAT NAMES ITS LAST COMMITTED ROTATION (`lastRotationChallengeId`, Round 24): it is this
    // ceremony's only when that id is this ceremony's own challenge, and then the result says so. Any other id settles
    // nothing (a different ceremony's rotation is the last one committed, or this one is still in flight), so it stays
    // unknown, and the revision count is not consulted, since another device's rotation moves it the same way.
    // ON A HOST THAT DOES NOT NAME IT: a rotation committed when the revision is EXACTLY one step on from the one read
    // just before its challenge (rotationSeq + 1, and a new keyCommitmentId when the host sends one); the result then
    // says it was read from the status, since a rotation on another device at the same moment would look the same.
    // An unchanged revision may still be a request in flight, so it stays unknown.
    try {
      const read = await readAumlokStatus(lasting, call)
      if (read.kind === 'live' && read.status.state === 'bound' && read.status.nodePubkeyHex === held.nodePubkeyHex) {
        const now = read.status
        if (intent === 'bind') return { ok: true, reason: AUMLOK_SETTLED_BY_STATUS }
        if (now.lastRotationChallengeId !== null) {
          if (held.challengeId !== null && now.lastRotationChallengeId === held.challengeId) {
            return { ok: true, reason: AUMLOK_SETTLED_AS_THIS_CEREMONY }
          }
          return refusal(AUMLOK_OUTCOME_UNKNOWN, true)
        }
        const before = held.before
        const oneStep = before.rotationSeq !== null && now.rotationSeq === before.rotationSeq + 1
          && (before.keyCommitmentId === null || now.keyCommitmentId !== before.keyCommitmentId)
        if (oneStep) return { ok: true, reason: AUMLOK_SETTLED_BY_STATUS }
      }
    } catch { /* the status read failed too: the outcome stays unknown */ }
    return refusal(AUMLOK_OUTCOME_UNKNOWN, true)
  }

  return {
    draw,
    submit,
    reset: () => { token += 1; pending = null; controller.abort(); controller = new AbortController() },
    takeSettled: () => { const value = settled; settled = null; return value },
    onSettled: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
