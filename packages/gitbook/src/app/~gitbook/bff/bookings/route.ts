import { type NextRequest, NextResponse } from 'next/server';

const getHeaders = (req: NextRequest): RequestInit['headers'] => {
    const accessToken = req.cookies.get('access_token')?.value;

    return accessToken
        ? {
              Cookie: `access_token=${encodeURIComponent(accessToken)}`,
          }
        : {};
};

export async function GET(req: NextRequest) {
    const incoming = req.nextUrl.searchParams;

    // Reencaminha os parâmetros do cliente (paginação/filtros) mantendo os defaults antigos,
    // para que `list_booking_actions` possa paginar e os filtros de `list_my_bookings` se apliquem.
    const params = new URLSearchParams({
        page: incoming.get('page') ?? '0',
        date: incoming.get('date') ?? 'booking',
        type: incoming.get('type') ?? 'ALL',
        sort: incoming.get('sort') ?? 'checkinDate',
        order: incoming.get('order') ?? 'ascend',
        lang: incoming.get('lang') ?? 'pt',
    });
    for (const key of ['state', 'startDate', 'endDate']) {
        const value = incoming.get(key);
        if (value) {
            params.set(key, value);
        }
    }

    const response = await fetch(
        `https://api.icligo.com/legacy-system/v1/bookings?${params.toString()}`,
        { headers: getHeaders(req), method: 'GET' }
    );

    try {
        const data = await response.json();
        return NextResponse.json(data);
    } catch (error) {
        return NextResponse.json(error);
    }
}
