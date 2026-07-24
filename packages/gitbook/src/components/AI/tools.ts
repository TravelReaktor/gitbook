import type { GitBookIntegrationTool } from '@gitbook/browser-types';
import { integrationsAssistantTools } from '../Integrations';
import { type AnyAIControlTool, getControlTools } from './controls';

const BOOKING_STATES = [
    'CHECKIN',
    'PENDING_PAYMENT',
    'CANCELED_NOT_PAID',
    'COMPLETED',
    'ON_APPROVAL',
    'PENDING_INVOICE',
    'CANCELED',
];

// Possíveis identificadores da ação de check-in dentro de `booking.actions`.
// TODO: substituir por um valor único e estável quando existir o endpoint dedicado de check-in.
const CHECKIN_ACTION_VALUES = ['CHECKIN', 'CHECK_IN', 'checkin', 'check-in'];

type BookingActionNode = {
    label: string;
    value: string;
    available?: boolean;
    options?: BookingActionNode[];
};

type BookingAction = { label: string; action: string; category: string | null; path: string };

// As ações de uma reserva vêm numa árvore: os nós de topo (ex. "Suporte") e intermédios
// (ex. "Gestão de reserva") são apenas categorias/agrupamentos; as ações concretas que o
// utilizador pode mesmo executar são as FOLHAS disponíveis (ex. "Reclamação").
// Percorre a árvore e devolve, achatadas, apenas as folhas com `available === true`,
// guardando o caminho de categorias para dar contexto.
const collectAvailableActions = (
    nodes: BookingActionNode[] | undefined,
    trail: string[] = [],
    parentValue: string | null = null
): BookingAction[] => {
    const result: BookingAction[] = [];

    for (const node of nodes ?? []) {
        if (node?.available !== true) {
            continue;
        }

        const path = [...trail, node.label];
        const availableChildren = (node.options ?? []).filter((child) => child?.available === true);

        if (availableChildren.length > 0) {
            result.push(...collectAvailableActions(node.options, path, node.value));
        } else {
            // `category` = valor do nó-pai (ex. "BOOKINGMANAGMENT"); necessário para abrir o
            // formulário de suporte via `open_booking_support_ticket` (category + action/type).
            result.push({
                label: node.label,
                action: node.value,
                category: parentValue,
                path: path.join(' > '),
            });
        }
    }

    return result;
};

const getBookings = async (
    page: number,
    size: number,
    filters: Record<string, unknown>,
    sort: Record<string, unknown>,
    locale: string
) => {
    const queryParams = new URLSearchParams({
        page: page.toString(),
        size: size.toString(),
        lang: locale,
        ...filters,
        ...sort,
    });

    const response = await fetch(`/~gitbook/bff/bookings?${queryParams.toString()}`, {
        method: 'GET',
        credentials: 'include',
    });

    return (await response.json()) satisfies { content: unknown[] };
};

const getBooking = async (bookingId: string, locale: string) => {
    const queryParams = new URLSearchParams({ lang: locale });

    const response = await fetch(
        `/~gitbook/bff/bookings/${encodeURIComponent(bookingId)}?${queryParams.toString()}`,
        {
            method: 'GET',
            credentials: 'include',
        }
    );

    return await response.json();
};

// Os formulários (suporte/reclamação, etc.) vivem sempre no MyOffice, independentemente de o
// assistente correr embebido no MyOffice ou na documentação standalone.
const MY_OFFICE_URL = 'https://myoffice.icligo.com';

export function getTools(
    builtInTools: GitBookIntegrationTool[] = [],
    // Locale da variante de língua atual do GitBook, para que as tools (API de reservas e o URL
    // do formulário de suporte) respeitem a língua onde o utilizador está na documentação.
    locale = 'pt'
): (GitBookIntegrationTool | AnyAIControlTool)[] {
    const integrationTools = integrationsAssistantTools.getState().tools;
    return [
        {
            name: 'list_my_bookings',
            description:
                "List the current user's own bookings/reservations. Use this when the user asks about their reservations, " +
                'upcoming trips or past travel, or wants to find a specific booking. You can optionally narrow the results ' +
                'by state and by a start/end date range. ' +
                'You MUST answer STRICTLY from the bookings this tool returns: report ONLY bookings and fields that are ' +
                'actually present. If the list comes back empty, tell the user plainly that no bookings were found for that ' +
                'query - NEVER invent, guess or infer bookings, dates, destinations, prices, states or any other value, and ' +
                'NEVER add bookings that were not returned. ' +
                'This returns at most the first 20 matching bookings, sorted by check-in date; if there may be more, say so ' +
                'instead of claiming it is the complete list.',
            inputSchema: {
                type: 'object',
                properties: {
                    state: {
                        type: 'string',
                        description: `Optional. Filter by booking state. If omitted, all bookings are returned. Possible values: ${BOOKING_STATES.join(', ')}.`,
                    },
                    startDate: {
                        type: 'string',
                        description: 'Optional. Only include bookings from this date onward (YYYY-MM-DD).',
                    },
                    endDate: {
                        type: 'string',
                        description: 'Optional. Only include bookings up to this date (YYYY-MM-DD).',
                    },
                },
            },
            async execute(input: object) {
                const { state, startDate, endDate } = input as {
                    state: string;
                    startDate?: string;
                    endDate?: string;
                };

                const filters = {
                    type: 'ALL',
                    date: 'booking',
                    ...(state && BOOKING_STATES.includes(state) ? { state: [state] } : {}),
                    ...(startDate ? { startDate } : {}),
                    ...(endDate ? { endDate } : {}),
                };
                const sort = { sort: 'checkinDate', order: 'ascend' };

                const data = await getBookings(0, 20, filters, sort, locale);
                const bookings = data.content ?? [];

                return {
                    output: { bookings, count: bookings.length },
                    summary: { icon: 'calendar', text: `Found ${bookings.length} booking(s)` },
                };
            },
        },
        {
            name: 'get_booking_details',
            description:
                'Get the details of ONE specific booking by its id (for example: dates, destination, guests, price, status, ' +
                'documents). Use this ONLY after `list_my_bookings`, with a bookingId that list_my_bookings returned, and ONLY ' +
                'when the user asks for more information about one of those bookings. ' +
                'You MUST answer STRICTLY from the data this tool returns: report ONLY fields that are actually present, and if ' +
                'a piece of information is missing or empty say it is not available - NEVER invent, guess, infer or complete ' +
                'dates, prices, names, statuses or any other value, and NEVER mix in data from other bookings. ' +
                'You MUST NOT expose sensitive or internal data: never reveal payment or card details, full identification/tax ' +
                "documents, internal identifiers, raw URLs or tokens, or another person's personal data; share only what the " +
                'user needs to identify and understand their own booking. ' +
                'You MUST NOT explain how to perform actions on the booking here - for available actions use `list_booking_actions` ' +
                'and for check-in steps use `explain_booking_checkin`.',
            inputSchema: {
                type: 'object',
                properties: {
                    bookingId: {
                        type: 'string',
                        description:
                            'The booking id, e.g. one of the ids returned by list_my_bookings.',
                    },
                },
            },
            async execute(input: object) {
                const { bookingId } = input as { bookingId: string };

                const booking = await getBooking(bookingId, locale);

                return {
                    output: { booking },
                    summary: { icon: 'calendar', text: `Details for booking ${bookingId}` },
                };
            },
        },
        {
            name: 'list_booking_actions',
            description:
                'List the concrete actions the current user can perform RIGHT NOW on ONE specific booking ' +
                '(for example: complaint, cancel, modify dates/guests, add insurance, send client data, check-in, ...). ' +
                'The booking actions are organised as a tree of categories; this tool walks that tree and returns ONLY ' +
                'the actual available actions (the leaves), each with a `label`, an `action` code, the `category` code of its ' +
                'parent group, and a `path` showing its category (e.g. "Suporte > Gestão de reserva > Reclamação"). ' +
                'Use this ONLY after `list_my_bookings` or `get_booking_details`, and ONLY when the user asks ' +
                'what they can do, which options/actions are available, or how to manage a specific booking. ' +
                'If `found` is false the booking could not be located: tell the user you could not find that booking and ' +
                'do NOT say it has no actions. If `found` is true and the `actions` list is not empty you MUST present those ' +
                'actions to the user and MUST NOT say the booking has no actions. You MUST NOT invent, assume or list actions ' +
                'that are not in the returned list, and you MUST NOT explain how to perform them here - to explain the ' +
                'check-in steps use `explain_booking_checkin`.',
            inputSchema: {
                type: 'object',
                properties: {
                    bookingId: {
                        type: 'string',
                        description:
                            'The booking id, e.g. one of the ids returned by list_my_bookings.',
                    },
                },
            },
            async execute(input: object) {
                const { bookingId } = input as { bookingId: string };

                // As ações de uma reserva NÃO vêm no detalhe (`getBooking`); só existem nos registos da
                // listagem (`getBookings`) - é daí que a app monta o menu de ações da reserva. Por isso
                // percorremos as páginas da listagem até encontrar a reserva com este id.
                const filters = { type: 'ALL', date: 'booking' };
                const sort = { sort: 'checkinDate', order: 'ascend' };
                const MAX_PAGES = 10;

                const matchesId = (booking: {
                    bookingId?: unknown;
                    id?: unknown;
                    locator?: unknown;
                }) =>
                    [booking?.bookingId, booking?.id, booking?.locator].some(
                        (value) => value != null && String(value) === String(bookingId)
                    );

                let record: Record<string, unknown> | undefined;
                for (let page = 0; page < MAX_PAGES; page += 1) {
                    const data = (await getBookings(
                        page,
                        20,
                        filters,
                        sort,
                        locale
                    )) as unknown as {
                        content?: Array<Record<string, unknown>>;
                        last?: boolean;
                    };
                    record = (data.content ?? []).find(matchesId);
                    if (record || data.last) {
                        break;
                    }
                }

                const found = Boolean(record);
                const actions = found
                    ? collectAvailableActions(record?.actions as BookingActionNode[] | undefined)
                    : [];

                return {
                    output: { bookingId, found, actions },
                    summary: {
                        icon: 'list-check',
                        text: found
                            ? `Found ${actions.length} available action(s) for booking ${bookingId}`
                            : `Booking ${bookingId} not found in the bookings list`,
                    },
                };
            },
        },
        {
            name: 'open_booking_support_ticket',
            description:
                'Open the support ticket form for a booking in a new browser tab, for a chosen category and type. ' +
                'Use ONLY with a support action returned by `list_booking_actions` for that same booking - i.e. one whose ' +
                '`path` starts with "Suporte" - passing that action\'s `category` as `category` and its `action` code as `type`. ' +
                'Do NOT use this tool for non-support actions (such as check-in).',
            confirmation: {
                icon: 'life-ring',
                label: 'Open support form',
            },
            inputSchema: {
                type: 'object',
                properties: {
                    bookingId: {
                        type: 'string',
                        description:
                            'The booking id, e.g. one of the ids returned by list_my_bookings.',
                    },
                    category: {
                        type: 'string',
                        description:
                            'The `category` code of a support action returned by list_booking_actions.',
                    },
                    type: {
                        type: 'string',
                        description:
                            'The `action` code of that same support action returned by list_booking_actions.',
                    },
                },
            },
            async execute(input: object) {
                const { bookingId, category, type } = input as {
                    bookingId: string;
                    category: string;
                    type: string;
                };

                // Locale da variante de língua atual, para abrir o formulário na língua correta.
                const url = `${MY_OFFICE_URL}/${locale}/forms/support?category=${encodeURIComponent(
                    category
                )}&type=${encodeURIComponent(type)}&booking=${encodeURIComponent(bookingId)}`;

                window.open(url, '_blank', 'noopener,noreferrer');

                return {
                    output: { url },
                    summary: {
                        icon: 'life-ring',
                        text: `Opened support form for booking ${bookingId}`,
                    },
                };
            },
        },
        {
            name: 'explain_booking_checkin',
            description:
                'Explain to the user, step by step, how to perform the CHECK-IN of ONE specific booking in the Backoffice. ' +
                'Use this ONLY when the user explicitly asks how to do / how to complete / how to make the check-in of a booking. ' +
                'This tool first confirms, from the booking data, whether check-in is currently available for that booking: ' +
                'if `available` is false you MUST tell the user that check-in is not possible right now and you MUST NOT invent steps; ' +
                'if `available` is true you MUST guide the user using ONLY the returned `steps`, in order, without adding steps of your own. ' +
                'You MUST NOT use this tool for any other action (cancel, modify, payment, contact, support) - it is exclusively for check-in.',
            inputSchema: {
                type: 'object',
                properties: {
                    bookingId: {
                        type: 'string',
                        description:
                            'The booking id, e.g. one of the ids returned by list_my_bookings.',
                    },
                },
            },
            async execute(input: object) {
                const { bookingId } = input as { bookingId: string };

                // NOTA: ainda não existe um endpoint dedicado às instruções de check-in.
                // Por agora reutilizamos `getBooking` para determinar se o check-in está disponível
                // na reserva; quando existir um endpoint próprio, `steps` deve passar a vir dele.
                const booking = (await getBooking(bookingId, locale)) as {
                    actions?: Array<{ value?: string; available?: boolean }>;
                };

                const checkinAction = (booking?.actions ?? []).find((action) =>
                    CHECKIN_ACTION_VALUES.includes(action?.value ?? '')
                );
                const available = checkinAction?.available === true;

                // TODO: obter estes passos do endpoint de check-in quando existir, em vez de os fixar aqui.
                const steps = available
                    ? [
                          'Abra a reserva a partir da lista de reservas ("As minhas reservas").',
                          'No detalhe da reserva, selecione a ação de check-in.',
                          'Confirme os dados dos hóspedes e conclua o check-in.',
                      ]
                    : [];

                return {
                    output: { bookingId, available, steps },
                    summary: {
                        icon: 'circle-check',
                        text: available
                            ? `Check-in instructions for booking ${bookingId}`
                            : `Check-in not available for booking ${bookingId}`,
                    },
                };
            },
        },
        ...getControlTools(),
        ...builtInTools,
        ...integrationTools,
    ];
}
