import { type NextRequest, NextResponse } from 'next/server';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ bookingId: string }> }
) {
    const { bookingId } = await params;
    const lang = req.nextUrl.searchParams.get('lang') ?? 'pt';

    const response = await fetch(
        `https://api.icligo.com/legacy-system/v1/bookings/${encodeURIComponent(bookingId)}?lang=${encodeURIComponent(lang)}`,
        { headers: req.headers, method: 'GET' }
    );

    try {
        const data = await response.json();
        return NextResponse.json(data);
    } catch (error) {
        return NextResponse.json(error);
    }
}
