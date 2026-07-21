/**
 * Cola este script na consola do browser (DevTools) enquanto estás numa página
 * do site local (ex: http://localhost:3000/url/icligo-1.gitbook.io/icligo-help-center),
 * para registares no assistente do GitBook as mesmas tools definidas no mfe
 * (apps/icligo-ui-backoffice/src/components/GitBook/gitBookTools.js).
 *
 * `window.GitBook.registerTool(...)` é a API pública já exposta pelo site
 * (ver packages/gitbook/src/components/Integrations/LoadIntegrations.tsx) —
 * não precisa de nenhuma alteração ao código deste projeto nem do mfe.
 *
 * Aqui o `execute()` de cada tool devolve dados de exemplo (MOCK), porque o
 * backend real de reservas só existe no mfe. Substitui os dados mock por um
 * `fetch(...)` real se quiseres testar contra a API a sério.
 */
(() => {
    const BOOKING_STATES = [
        'CHECKIN',
        'PENDING_PAYMENT',
        'CANCELED_NOT_PAID',
        'COMPLETED',
        'ON_APPROVAL',
        'PENDING_INVOICE',
        'CANCELED',
    ];

    window.GitBook.registerTool({
        name: 'list_my_bookings',
        description:
            "List the current user's bookings. Use when the user asks about reservations or travel history. Optionally filter by status, start date, end date.",
        inputSchema: {
            type: 'object',
            properties: {
                state: {
                    type: 'string',
                    description: `Optional. Filter by booking state. Possible values: ${BOOKING_STATES.join(', ')}.`,
                },
                startDate: { type: 'string', description: 'Optional. From date (YYYY-MM-DD).' },
                endDate: { type: 'string', description: 'Optional. To date (YYYY-MM-DD).' },
            },
        },
        async execute(input) {
            const bookings = [
                {
                    id: 'BK-1001',
                    checkinDate: '2026-08-01',
                    checkoutDate: '2026-08-05',
                    state: 'CHECKIN',
                    destination: 'Lisboa',
                },
                {
                    id: 'BK-1002',
                    checkinDate: '2026-09-10',
                    checkoutDate: '2026-09-12',
                    state: 'PENDING_PAYMENT',
                    destination: 'Porto',
                },
            ].filter((b) => !input.state || b.state === input.state);
            return {
                output: { bookings, count: bookings.length },
                summary: { icon: 'calendar', text: `[MOCK] Found ${bookings.length} booking(s)` },
            };
        },
    });

    window.GitBook.registerTool({
        name: 'get_booking_details',
        description:
            'Get full details for a single booking by its id (dates, guests, price, status, ...). Use after "list_my_bookings".',
        inputSchema: {
            type: 'object',
            properties: {
                bookingId: {
                    type: 'string',
                    description:
                        'The booking id, e.g. one of the ids returned by list_my_bookings.',
                },
            },
            required: ['bookingId'],
        },
        async execute(input) {
            const booking = {
                id: input.bookingId,
                checkinDate: '2026-08-01',
                checkoutDate: '2026-08-05',
                guests: 2,
                price: '350€',
                state: 'CHECKIN',
            };
            return {
                output: { booking },
                summary: {
                    icon: 'calendar',
                    text: `[MOCK] Details for booking ${input.bookingId}`,
                },
            };
        },
    });

    window.GitBook.registerTool({
        name: 'list_booking_support_options',
        description:
            'List the support ticket categories/types that can be opened for a specific booking. Use after list_my_bookings or get_booking_details.',
        inputSchema: {
            type: 'object',
            properties: { bookingId: { type: 'string', description: 'The booking id.' } },
            required: ['bookingId'],
        },
        async execute(input) {
            const categories = [
                {
                    label: 'Pagamento',
                    category: 'payment',
                    types: [{ label: 'Problema com pagamento', type: 'payment_issue' }],
                },
            ];
            return {
                output: { bookingId: input.bookingId, categories },
                summary: {
                    icon: 'life-ring',
                    text: `[MOCK] Found ${categories.length} support option(s)`,
                },
            };
        },
    });

    window.GitBook.registerTool({
        name: 'open_booking_support_ticket',
        description:
            'Open the support ticket form for a booking, for a chosen category and type. Use only with a category/type pair returned by list_booking_support_options.',
        confirmation: { icon: 'life-ring', label: 'Open support form' },
        inputSchema: {
            type: 'object',
            properties: {
                bookingId: { type: 'string', description: 'The booking id.' },
                category: { type: 'string', description: 'The category value.' },
                type: { type: 'string', description: 'The type value.' },
            },
            required: ['bookingId', 'category', 'type'],
        },
        async execute(input) {
            console.log('[MOCK] would open support form for', input);
            return {
                output: { url: '(mock, not opened)' },
                summary: {
                    icon: 'life-ring',
                    text: `[MOCK] Opened support form for booking ${input.bookingId}`,
                },
            };
        },
    });

    console.log('[dev-tools] registered 4 mock mfe tools on window.GitBook');
})();
