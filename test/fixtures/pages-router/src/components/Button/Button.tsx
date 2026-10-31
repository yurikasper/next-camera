import React from "react";

interface ButtonProps {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: "primary" | "secondary";
    className?: string;
}

const Button: React.FC<ButtonProps> = ({
    children,
    onClick,
    disabled = false,
    variant = "primary",
    className = "",
}) => {
    const baseStyles = "px-4 py-2 rounded-xl font-medium transition-colors";
    const variantStyles = {
        primary:
            "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400",
        secondary:
            "bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:bg-gray-100",
    };

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`${baseStyles} ${variantStyles[variant]} ${className}`}
        >
            {children}
        </button>
    );
};

export default Button;
