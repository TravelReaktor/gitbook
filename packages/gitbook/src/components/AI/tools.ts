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

export function getTools(
    builtInTools: GitBookIntegrationTool[] = []
): (GitBookIntegrationTool | AnyAIControlTool)[] {
    const integrationTools = integrationsAssistantTools.getState().tools;
    return [
        {
            name: 'list_my_bookings',
            description:
                "List the current user's bookings. Use when the user asks about reservations or travel history. " +
                'Optionally filter by status, start date, end date.',
            inputSchema: {
                type: 'object',
                properties: {
                    state: {
                        type: 'string',
                        description: `Optional. Filter by booking state. If omitted, all bookings are returned. Possible values: ${BOOKING_STATES.join(', ')}.`,
                    },
                    startDate: { type: 'string', description: 'Optional. From date (YYYY-MM-DD).' },
                    endDate: { type: 'string', description: 'Optional. To date (YYYY-MM-DD).' },
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

                const data = await getBookings(0, 20, filters, sort, 'pt');
                const bookings = data.content ?? [];

                return {
                    output: { bookings, count: bookings.length },
                    summary: { icon: 'calendar', text: `Found ${bookings.length} booking(s)` },
                };
            },
        },
        ...getControlTools(),
        ...builtInTools,
        ...integrationTools,
    ];
}
