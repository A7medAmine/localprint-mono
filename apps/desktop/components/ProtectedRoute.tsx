import React from "react";
import { Navigate } from "react-router-dom";

interface ProtectedRouteProps {
  isAdmin: boolean;
  children: React.ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ isAdmin, children }) => {
  if (!isAdmin) {
    return <Navigate to="/admin/login" replace />;
  }
  return <>{children}</>;
};

export default ProtectedRoute;
