import { IndirectUse } from "@/components/IndirectUse/IndirectUse";

export default function IndirectPage() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center p-24">
            <main className="flex flex-col items-center gap-8">
                <h1 className="text-4xl font-bold">Indirect use</h1>
                <p className="text-lg text-gray-600">
                    This is a simple page in the app router with indirect usage
                    of Button.
                </p>
                <IndirectUse />
            </main>
        </div>
    );
}
