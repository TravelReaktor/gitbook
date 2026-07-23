import { type NextRequest, NextResponse } from 'next/server';

export async function GET(_req: NextRequest) {
    const response = await fetch(
        'https://api.icligo.com/legacy-system/v1/bookings?page=0&date=booking&type=ALL&sort=checkinDate&order=ascend&lang=pt',
        { headers: _req.headers, method: 'GET' }
    );

    try {
        const data = await response.json();
        return NextResponse.json(data);
    } catch (error) {
        return NextResponse.json(error);
    }
}
