import { IndirectUse } from "@/components/IndirectUse/IndirectUse";
import type { NextPage } from "next";

const IndirectPage: NextPage = () => {
    return (
        <div>
            <h1>Indirect Use</h1>
            <p>This is a simple page demonstrating indirect component usage.</p>
            <IndirectUse />
        </div>
    );
};

export default IndirectPage;
